import { createHash, createHmac } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { configPath } from '../config/paths.ts';
import { readJson, onlyKeys, ConfigurationError } from '../config/files.ts';
import { MAX_ARTIFACT, LIMITS, safePath } from './protocol.ts';

export const sha256 = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const hex = /^[0-9a-f]{64}$/;
const jobPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export function jobId(value: string) { if (!jobPattern.test(value)) throw new Error('invalid job id'); }
export type BlobConfig = { endpoint: string; bucket: string; principal: string; region: string; credentialFile: string; publication?: 'automatic' | 'manual' };
export type BlobManifest = { version: 1; jobId: string; principal: string; createdAt: number; expiresAt: number;
  requested: string[]; artifacts: { path: string; size: number; sha256: string }[] };
export const RETENTION = 14 * 86400;
export const MANIFEST_CAP = 1024 * 1024;

export function blobConfig(): BlobConfig | undefined {
  const c = readJson(configPath('blob'), true);
  if (!Object.keys(c).length) return;
  onlyKeys(c, ['version', 'endpoint', 'bucket', 'principal', 'region', 'credentialFile', 'publication']);
  if (c.version !== 1 || ['endpoint', 'bucket', 'principal', 'region', 'credentialFile'].some(k => typeof c[k] !== 'string'))
    throw new ConfigurationError('Invalid blob configuration');
  if (c.publication !== undefined && c.publication !== 'automatic' && c.publication !== 'manual')
    throw new ConfigurationError('Invalid blob publication mode');
  const config = c as unknown as BlobConfig;
  let u: URL;
  try { u = new URL(config.endpoint); } catch { throw new ConfigurationError('Invalid blob endpoint'); }
  if (u.username || u.password || u.search || u.hash || u.pathname !== '/' ||
      !(u.protocol === 'https:' || (u.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(u.hostname))) ||
      !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(config.bucket) ||
      !/^[a-zA-Z0-9_-]{1,64}$/.test(config.principal) || !/^[a-z0-9-]{1,64}$/.test(config.region) ||
      !isAbsolute(config.credentialFile)) throw new ConfigurationError('Invalid blob configuration');
  return { ...config, endpoint: u.origin };
}
export const storeIdentity = (c: BlobConfig) => sha256(JSON.stringify([c.endpoint, c.bucket, c.principal, c.region]));
const encode = (value: string) => encodeURIComponent(value).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
const hmac = (key: Uint8Array | string, value: string) => createHmac('sha256', key).update(value).digest();

/** Bounded S3 path-style transport. Garage bootstrap issues the existing keys;
 * this client only reads their private target-local projection. No issuance. */
export class BlobStore {
  readonly config: BlobConfig;
  private access: string;
  private secret: string;
  constructor(config: BlobConfig) {
    this.config = config;
    const key = readJson(config.credentialFile, false, undefined, { secret: true, maxBytes: 4096 });
    onlyKeys(key, ['accessKeyId', 'secretAccessKey']);
    if (typeof key.accessKeyId !== 'string' || !/^[A-Za-z0-9]{1,128}$/.test(key.accessKeyId) ||
        typeof key.secretAccessKey !== 'string' || !/^[A-Za-z0-9/+_=.-]{1,256}$/.test(key.secretAccessKey))
      throw new ConfigurationError('Invalid blob credential', config.credentialFile);
    this.access = key.accessKeyId; this.secret = key.secretAccessKey;
  }
  async request(method: 'GET' | 'PUT', key: string, bytes: Buffer = Buffer.alloc(0), query: Record<string, string> = {}, cap = MAX_ARTIFACT) {
    const response = await this.exchange(method, key, bytes, query, cap, 15_000, true);
    if (response.status !== 200) throw new Error('blob_http_' + response.status);
    return response.body;
  }
  async exchange(method: 'GET' | 'PUT' | 'DELETE', key: string, bytes: Buffer = Buffer.alloc(0), query: Record<string, string> = {}, cap = MAX_ARTIFACT, timeoutMs = 15_000, requireOK = false) {
    const c = this.config;
    const path = '/' + [c.bucket, ...key.split('/').filter(Boolean)].map(encode).join('/');
    const search = Object.entries(query).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => encode(k) + '=' + encode(v)).join('&');
    const date = new Date().toISOString().replace(/[:-]|\.\d{3}/g, ''), day = date.slice(0, 8);
    const hash = sha256(bytes), host = new URL(c.endpoint).host;
    const names = 'host;x-amz-content-sha256;x-amz-date';
    const canonical = [method, path, search, 'host:' + host + '\nx-amz-content-sha256:' + hash + '\nx-amz-date:' + date + '\n', names, hash].join('\n');
    const scope = day + '/' + c.region + '/s3/aws4_request';
    const signing = hmac(hmac(hmac(hmac('AWS4' + this.secret, day), c.region), 's3'), 'aws4_request');
    const signature = createHmac('sha256', signing).update('AWS4-HMAC-SHA256\n' + date + '\n' + scope + '\n' + sha256(canonical)).digest('hex');
    const headers = { 'x-amz-date': date, 'x-amz-content-sha256': hash,
      authorization: 'AWS4-HMAC-SHA256 Credential=' + this.access + '/' + scope + ', SignedHeaders=' + names + ', Signature=' + signature };
    const response = await fetch(c.endpoint + path + (search ? '?' + search : ''), {
      method, headers, ...(method === 'PUT' ? { body: new Uint8Array(bytes) } : {}),
      signal: AbortSignal.timeout(timeoutMs), redirect: 'error',
    });
    if (requireOK && response.status !== 200) { await response.body?.cancel(); throw new Error('blob_http_' + response.status); }
    const chunks: Buffer[] = []; let size = 0;
    try {
      for await (const chunk of response.body ?? []) {
        size += chunk.length; if (size > cap) throw new Error('blob_response_bound');
        chunks.push(Buffer.from(chunk));
      }
    } catch (error) { await response.body?.cancel().catch(() => {}); throw error; }
    return { status: response.status, body: Buffer.concat(chunks) };
  }
  async manifest(id: string) {
    jobId(id);
    const prefix = 'v1/' + id + '/manifests/';
    const bytes = await this.request('GET', '', undefined, { 'list-type': '2', 'max-keys': '2', prefix }, MANIFEST_CAP);
    const xml = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    // Only the fixed ASCII key projection is consumed, never arbitrary XML.
    // Entity declarations and truncated/unknown listings refuse.
    if (/<!/.test(xml) || !/<ListBucketResult\b[^>]*>[\s\S]*<\/ListBucketResult>\s*$/.test(xml) || !/<IsTruncated>false<\/IsTruncated>/.test(xml)) throw new Error('blob_listing_bound');
    const keys = [...xml.matchAll(/<Key>([^<]*)<\/Key>/g)].map(m => m[1]!);
    if (keys.length !== 1) throw new Error(keys.length ? 'blob_manifest_conflict' : 'blob_manifest_missing');
    const key = keys[0]!;
    if (!key.startsWith(prefix) || !hex.test(key.slice(prefix.length, -5)) || !key.endsWith('.json')) throw new Error('blob_manifest_key');
    const body = await this.request('GET', key, undefined, {}, MANIFEST_CAP);
    if (sha256(body) !== key.slice(prefix.length, -5)) throw new Error('blob_manifest_integrity');
    return { key, body, value: validateManifest(body, id, this.config.principal) };
  }
}

export function validateManifest(body: Buffer, id: string, principal: string, now = Math.floor(Date.now() / 1000)): BlobManifest {
  jobId(id);
  if (body.length > MANIFEST_CAP) throw new Error('blob_manifest_bound');
  const m = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
  if (!m || typeof m !== 'object' || Array.isArray(m) ||
      Object.keys(m).sort().join(',') !== 'artifacts,createdAt,expiresAt,jobId,principal,requested,version' ||
      m.version !== 1 || m.jobId !== id || m.principal !== principal ||
      !Number.isSafeInteger(m.createdAt) || !Number.isSafeInteger(m.expiresAt) ||
      m.createdAt > now + 300 || m.expiresAt !== m.createdAt + RETENTION || now >= m.expiresAt ||
      !Array.isArray(m.requested) || !m.requested.length || m.requested.length > LIMITS.maxArtifacts ||
      !Array.isArray(m.artifacts) || m.artifacts.length > m.requested.length) throw new Error('blob_manifest_binding');
  m.requested.forEach(safePath);
  if (new Set(m.requested).size !== m.requested.length) throw new Error('blob_manifest_paths');
  let total = 0; const seen = new Set<string>();
  for (const a of m.artifacts) {
    if (!a || typeof a !== 'object' || Object.keys(a).sort().join(',') !== 'path,sha256,size') throw new Error('blob_artifact_binding');
    safePath(a.path);
    if (!m.requested.includes(a.path) || seen.has(a.path) || typeof a.sha256 !== 'string' || !hex.test(a.sha256) ||
        !Number.isSafeInteger(a.size) || a.size < 0 || (total += a.size) > MAX_ARTIFACT) throw new Error('blob_artifact_bounds');
    seen.add(a.path);
  }
  return m;
}
