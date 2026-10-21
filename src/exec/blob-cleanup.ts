import { RETENTION, MANIFEST_CAP, sha256, validateManifest, type BlobStore } from './blob.ts';

const ABANDONED = 86400;
export type CleanupLimits = {
  maxRequests: number; maxRequestBytes: number; maxResponseBytes: number;
  maxPageBytes: number; maxCandidates: number; maxElapsedMs: number; maxMutations: number; pageSize: number;
};
export type CleanupPolicy = {
  bucket: string; principal: string; prefix: 'v1/'; allowExpiredLastCopy: true; writersQuiesced: true; limits: CleanupLimits;
};
export type CleanupResult = {
  scanned: boolean; attempted: number; objects: number; uploads: number; uncertain: boolean;
};
export class BlobCleanupError extends Error {
  readonly result: CleanupResult;
  constructor(reason: string, result: CleanupResult) { super(reason); this.result = { ...result }; }
}
type Transport = Pick<BlobStore, 'config' | 'exchange'>;
type Node = { name: string; text: string; children: Node[] };
type Row = { key: string; stamp: number; etag?: string; size?: number; upload?: string };
const fail = (reason: string): never => { throw new Error('blob_cleanup_' + reason); };
const encode = (value: string) => encodeURIComponent(value).replace(/[!'()*]/g,
  c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
function requestSize(method: string, bucket: string, path: string, query: Record<string, string>) {
  const resource = [bucket, ...path.split('/').filter(Boolean)].map(encode).join('/');
  const search = Object.entries(query).map(([k, v]) => encode(k) + '=' + encode(v)).join('&');
  return Buffer.byteLength(method + '/' + resource + (search ? '?' + search : ''));
}

// Deliberately restricted S3 XML, with no DTD, comments, CDATA, attributes on
// members, mixed content or namespace aliases. Unknown fields refuse below.
function xml(bytes: Buffer, rootName: string): Node {
  const decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  // XML 1.0 Char and S productions, before normalization can hide invalid input.
  if (/[^\u0009\u000a\u000d\u0020-\ud7ff\ue000-\ufffd\u{10000}-\u{10ffff}]/u.test(decoded)) fail('xml');
  const source = decoded.replace(/^<\?xml version="1.0"(?: encoding="UTF-8")?\?>[ \t\r\n]*/, '')
    .replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, '');
  const stack: Node[] = [], roots: Node[] = [];
  for (const token of source.match(/<[^>]*>|[^<]+/g) ?? []) {
    if (token.startsWith('</')) {
      const node = stack.pop();
      if (!node || token !== '</' + node.name + '>') fail('xml');
    } else if (token.startsWith('<')) {
      const match = /^<([A-Za-z][A-Za-z0-9]*)(?: xmlns="http:\/\/s3.amazonaws.com\/doc\/2006-03-01\/")?(\/?)>$/.exec(token);
      if (!match || (stack.length && token.includes(' xmlns=')) || stack.length > 3) fail('xml');
      const node: Node = { name: match![1]!, text: '', children: [] };
      (stack.length ? stack[stack.length - 1]!.children : roots).push(node);
      if (!match![2]) stack.push(node);
    } else {
      if (!stack.length) { if (/[^ \t\r\n]/.test(token)) fail('xml'); continue; }
      stack[stack.length - 1]!.text += token;
    }
  }
  if (stack.length || roots.length !== 1 || roots[0]!.name !== rootName || source.includes('<!') ||
      source.includes('<?') || !source.endsWith('</' + rootName + '>')) fail('xml');
  function validate(node: Node) {
    if (node.text.includes(']]>') || (node.children.length && /[^ \t\r\n]/.test(node.text)) ||
        /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(node.text) ||
        /&(?!(?:amp|lt|gt|quot|apos);)/.test(node.text)) fail('xml');
    node.children.forEach(validate);
  }
  validate(roots[0]!);
  return roots[0]!;
}
function fields(node: Node, allowed: string[], repeated = '') {
  if (/[^ \t\r\n]/.test(node.text)) fail('xml_mixed');
  const seen = new Set<string>();
  for (const child of node.children) {
    if (!allowed.includes(child.name) || (seen.has(child.name) && child.name !== repeated)) fail('xml_field');
    seen.add(child.name);
    if (child.name === 'Owner' || child.name === 'Initiator') {
      fields(child, ['ID', 'DisplayName']);
      for (const field of child.children) value(child, field.name);
    } else if (child.name !== repeated && child.children.length) fail('xml_field');
  }
}
function value(node: Node, name: string, optional = false): string {
  const nodes = node.children.filter(c => c.name === name);
  if (!nodes.length && optional) return '';
  if (nodes.length !== 1 || nodes[0]!.children.length) return fail('xml_field');
  const text = nodes[0]!.text;
  if (/&(?!(?:amp|lt|gt|quot|apos);)/.test(text)) fail('xml_entity');
  return text.replace(/&(amp|lt|gt|quot|apos);/g, (_, entity: string) =>
    ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" })[entity]!);
}
function time(value: string, now: number) {
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value)) return fail('timestamp');
  const milliseconds = Date.parse(value);
  // Round-trip validation rejects impossible dates silently normalized by Date.
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString().slice(0, 19) !== value.slice(0, 19) ||
      milliseconds / 1000 > now) return fail('timestamp');
  return milliseconds / 1000;
}
function key(value: string) {
  if (!/^v1\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/(?:objects\/[0-9a-f]{64}|manifests\/[0-9a-f]{64}\.json)$/.test(value))
    fail('key');
  return value;
}
function uint(value: string) {
  if (!/^(?:0|[1-9][0-9]*)$/.test(value) || !Number.isSafeInteger(Number(value))) return fail('integer');
  return Number(value);
}

/** Source-only entry point. The caller supplies a protected bucket/principal
 * binding, a trusted clock and exclusive writer coordination. No retry or timer.
 * Expiry deliberately permits loss of the final remote copy. */
export async function cleanupBlobs(store: Transport, policy: CleanupPolicy,
  clock = { now: () => Date.now() / 1000, monotonic: () => performance.now() }): Promise<CleanupResult> {
  const result: CleanupResult = { scanned: false, attempted: 0, objects: 0, uploads: 0, uncertain: false };
  try {
    const l = policy.limits;
    if (policy.bucket !== store.config.bucket || policy.principal !== store.config.principal ||
        !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(policy.bucket) ||
        !/^[A-Za-z0-9_-]{1,64}$/.test(policy.principal) ||
        policy.prefix !== 'v1/' || policy.allowExpiredLastCopy !== true || policy.writersQuiesced !== true ||
        Object.keys(l).sort().join(',') !== 'maxCandidates,maxElapsedMs,maxMutations,maxPageBytes,maxRequestBytes,maxRequests,maxResponseBytes,pageSize' || Object.values(l).some(v => !Number.isSafeInteger(v) || v <= 0) ||
        l.pageSize > 1000 || l.maxElapsedMs > 2_147_483_647) fail('policy');
    const now = clock.now(), start = clock.monotonic();
    if (!Number.isFinite(now) || now < 0 || !Number.isFinite(start)) fail('clock');
    let requests = 0, requestBytes = 0, responseBytes = 0, candidates = 0;
    function remaining() {
      const elapsed = clock.monotonic() - start;
      if (!Number.isFinite(elapsed) || elapsed < 0 || elapsed >= l.maxElapsedMs) fail('elapsed');
      return Math.max(1, Math.floor(l.maxElapsedMs - elapsed));
    }
    async function request(method: 'GET' | 'DELETE', path: string, query: Record<string, string> = {}, cap = l.maxPageBytes) {
      const timeout = remaining();
      requestBytes += requestSize(method, policy.bucket, path, query);
      if (++requests > l.maxRequests || requestBytes > l.maxRequestBytes) fail('request_bound');
      const available = Math.min(cap, l.maxPageBytes, l.maxResponseBytes - responseBytes);
      if (available <= 0) fail('response_bound');
      const reply = await store.exchange(method, path, undefined, query, available, timeout);
      remaining();
      responseBytes += reply.body.length;
      if (reply.body.length > available || responseBytes > l.maxResponseBytes) fail('response_bound');
      return reply;
    }
    async function listing(multipart: boolean): Promise<Row[]> {
      const rows: Row[] = [], seen = new Set<string>(), markers = new Set<string>();
      let marker = '', uploadMarker = '', previous = '';
      for (;;) {
        const query: Record<string, string> = multipart
          ? { uploads: '', 'max-uploads': String(l.pageSize), prefix: policy.prefix }
          : { 'list-type': '2', 'max-keys': String(l.pageSize), prefix: policy.prefix };
        if (marker) {
          if (multipart) { query['key-marker'] = marker; query['upload-id-marker'] = uploadMarker; }
          else query['continuation-token'] = marker;
        }
        const reply = await request('GET', '', query);
        if (reply.status !== 200) fail('listing_http_' + reply.status);
        const root = xml(reply.body, multipart ? 'ListMultipartUploadsResult' : 'ListBucketResult');
        const member = multipart ? 'Upload' : 'Contents';
        fields(root, multipart
          ? ['Bucket', 'Prefix', 'KeyMarker', 'UploadIdMarker', 'NextKeyMarker', 'NextUploadIdMarker', 'MaxUploads', 'IsTruncated', member]
          : ['Name', 'Prefix', 'ContinuationToken', 'NextContinuationToken', 'MaxKeys', 'KeyCount', 'IsTruncated', member], member);
        if (value(root, multipart ? 'Bucket' : 'Name') !== policy.bucket || value(root, 'Prefix') !== policy.prefix ||
            uint(value(root, multipart ? 'MaxUploads' : 'MaxKeys')) !== l.pageSize) fail('listing_identity');
        if (multipart) {
          if (value(root, 'KeyMarker', true) !== marker || value(root, 'UploadIdMarker', true) !== uploadMarker) fail('marker_identity');
        } else if (value(root, 'ContinuationToken', true) !== marker) fail('marker_identity');
        const page = root.children.filter(n => n.name === member);
        if (page.length > l.pageSize || (!multipart && root.children.some(n => n.name === 'KeyCount') &&
            uint(value(root, 'KeyCount')) !== page.length)) fail('page_bound');
        for (const node of page) {
          if (++candidates > l.maxCandidates) fail('candidate_bound');
          fields(node, multipart ? ['Key', 'UploadId', 'Initiated', 'Owner', 'Initiator', 'StorageClass']
            : ['Key', 'LastModified', 'ETag', 'Size', 'StorageClass', 'Owner']);
          const row: Row = { key: key(value(node, 'Key')), stamp: time(value(node, multipart ? 'Initiated' : 'LastModified'), now) };
          if (multipart) {
            row.upload = value(node, 'UploadId');
            if (!/^[A-Za-z0-9_+/=.-]{1,1024}$/.test(row.upload)) fail('upload_id');
          } else {
            row.etag = value(node, 'ETag'); row.size = uint(value(node, 'Size'));
            if (!/^"[a-zA-Z0-9-]{1,128}"$/.test(row.etag)) fail('etag');
          }
          const identity = JSON.stringify([row.key, row.upload ?? '']);
          // Object keys are lexically ordered. Upload IDs are opaque; require
          // uniqueness and nondecreasing keys, without assuming ID ordering.
          if (seen.has(identity) || (previous && (multipart ? row.key < previous : row.key <= previous))) fail('listing_progress');
          previous = row.key; seen.add(identity); rows.push(row);
        }
        const truncated = value(root, 'IsTruncated');
        const next = value(root, multipart ? 'NextKeyMarker' : 'NextContinuationToken', true);
        const nextUpload = multipart ? value(root, 'NextUploadIdMarker', true) : '';
        if (truncated === 'false') {
          if (next || nextUpload) fail('terminal_marker');
          return rows;
        }
        if (truncated !== 'true' || !page.length || !next || next.length > 2048 ||
            /[\x00-\x20\x7f]/.test(next) || (multipart && (!nextUpload || next !== rows[rows.length - 1]!.key ||
              nextUpload !== rows[rows.length - 1]!.upload))) fail('listing_progress');
        const identity = JSON.stringify([next, nextUpload]);
        if (markers.has(identity) || (next === marker && nextUpload === uploadMarker)) fail('listing_progress');
        markers.add(identity); marker = next; uploadMarker = nextUpload;
      }
    }
    async function scan() {
      const objects = await listing(false), uploads = await listing(true);
      const manifests = new Map<string, { expires: number; body: string }[]>();
      for (const row of objects.filter(r => r.key.includes('/manifests/'))) {
        const reply = await request('GET', row.key, {}, MANIFEST_CAP);
        if (reply.status !== 200 || row.size !== reply.body.length || sha256(reply.body) !== row.key.split('/').pop()!.slice(0, -5)) fail('manifest_integrity');
        const raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(reply.body));
        const id = row.key.split('/')[1]!;
        const manifest = validateManifest(reply.body, id, policy.principal, raw.createdAt);
        if (manifest.createdAt < 0 || manifest.createdAt > now || manifest.createdAt > row.stamp) fail('manifest_time');
        for (const entry of manifest.artifacts) {
          const object = objects.find(r => r.key === 'v1/' + id + '/objects/' + entry.sha256);
          if ((!object && manifest.expiresAt > now) || (object && object.size !== entry.size)) fail('manifest_object');
        }
        const group = manifests.get(id) ?? [];
        group.push({ expires: manifest.expiresAt, body: sha256(reply.body) }); manifests.set(id, group);
      }
      const expired = objects.filter(row => {
        const id = row.key.split('/')[1]!, group = manifests.get(id);
        return group && group.every(m => m.expires <= now) &&
          objects.filter(r => r.key.split('/')[1] === id).every(r => r.stamp + RETENTION <= now);
      });
      return { objects, uploads, manifests: [...manifests], expired,
        abandoned: uploads.filter(r => r.stamp + ABANDONED <= now) };
    }
    const first = await scan(), second = await scan();
    if (JSON.stringify(first) !== JSON.stringify(second)) fail('scan_changed');
    result.scanned = true;
    const mutations = [...first.abandoned.map(r => ({ ...r, kind: 'uploads' as const })),
      ...first.expired.sort((a, b) => Number(a.key.includes('/manifests/')) - Number(b.key.includes('/manifests/')))
        .map(r => ({ ...r, kind: 'objects' as const }))];
    if (mutations.length > l.maxMutations) fail('mutation_bound');
    // Reserve request count and logical bytes for the entire mutation batch.
    const bytes = mutations.reduce((sum, r) => sum + requestSize('DELETE', policy.bucket, r.key,
      r.upload ? { uploadId: r.upload } : {}), 0);
    if (requests + mutations.length > l.maxRequests || requestBytes + bytes > l.maxRequestBytes) fail('request_bound');
    remaining();
    for (const row of mutations) {
      remaining(); result.attempted++;
      try {
        const reply = await request('DELETE', row.key, row.upload ? { uploadId: row.upload } : {});
        if (reply.status !== 204 && reply.status !== 404) fail('mutation_http_' + reply.status);
        result[row.kind]++;
      } catch (error) { result.uncertain = true; throw error; }
    }
    return result;
  } catch (error) {
    throw new BlobCleanupError(error instanceof Error ? error.message : 'blob_cleanup_failed', result);
  }
}
