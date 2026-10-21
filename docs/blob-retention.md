# Bounded source cleanup

`cleanupBlobs` in `src/exec/blob-cleanup.ts` is a caller-supplied source entry point.
It reuses `BlobStore.exchange`, the existing SigV4 transport and descriptor-based
private credential reader. Nothing calls it by default. There is no CLI, service,
timer, credential issuer or deployment configuration.

The caller must protect the endpoint/bucket/principal binding and cleanup key,
supply a trusted clock, and quiesce writers for the entire invocation. The explicit
`writersQuiesced: true` is a caller assertion, not a lock or a proof. Cleanup checks
that its policy matches the transport's bucket and principal and accepts only
`v1/` keys with the published UUID/object/manifest shape. Bucket ACLs remain the
principal isolation boundary. S3 listing owner IDs cannot establish the application
principal; every manifest is hash checked and validated against the configured
principal.

All limits are required positive safe integers. `pageSize` is at most 1000 and
`maxElapsedMs` is at most 2147483647. The policy supplies maximum request count,
aggregate logical request bytes, aggregate response body bytes, per-response body
bytes, scanned rows, elapsed milliseconds and attempted mutations. Logical request
bytes cover method plus encoded bucket/key/query, excluding HTTP/TLS headers.
Scanned rows count every object/upload visit across both scans, including rows
that are retained. Manifest GETs consume request and response budgets. The elapsed
budget includes scanning, parsing, manifest validation and mutation; each request
gets the remaining deadline. A custom transport must honor its supplied response
cap and timeout, like BlobStore. No automatic retry occurs.

Both object ListObjectsV2 and multipart listings must complete within these limits.
Cleanup checks bucket, prefix, page size, row counts, marker echoes, duplicate rows,
ordering and continuation progress. Multipart continuation uses the exact last
key/upload-ID pair; upload IDs are opaque. Unknown or malformed listing fields,
timestamps, keys and markers refuse. XML accepts the restricted default-namespace
S3 form, not arbitrary XML extensions. A second complete scan and manifest read
must match the first. The entire mutation count and request count/byte allowance
must fit before any delete or abort. Any incomplete, changed, malformed, timed-out
or overbound scan has zero destructive effects.

A server LastModified timestamp starts the fixed fourteen-day object age.
Initiated starts the fixed one-day abandoned-upload age. Future or invalid server
timestamps refuse the whole scan; caller-provided manifest ages cannot shorten
these thresholds. An object's entire listed job group is retained until all its
members are old enough and all its validated manifests have expired. A recent
manifest therefore protects older objects. Orphan completed objects without a
manifest are retained for operator reconciliation, rather than guessing their
custody or expiry. Active manifests with missing objects refuse. Expired manifests
can reference already removed objects so a partial cleanup can resume. Conflicting
valid manifests are removed only after every manifest expires and the whole group
meets the server-age rule.

`allowExpiredLastCopy: true` explicitly accepts expiry of the last remote copy.
This policy is not an archival guarantee. Cleanup never reads or removes the
producer's local custody journal or pending local artifacts. Their existing
last-local-copy protection is unchanged.

Aborts run first, completed objects next, manifests last. HTTP204 and HTTP404 are
confirmed idempotent outcomes. The returned counts include only these confirmed
outcomes. On failure `BlobCleanupError.result` retains the completed counts,
attempted count, whether both scans finished, and a conservative `uncertain`
flag once a mutation attempt fails. A lost reply can mean the mutation happened.
The batch is not atomic; a later invocation rescans instead of replaying a cached
candidate list. No failure is reported as a successful full cleanup.

Two equal S3 listings are not an immutable snapshot. A same-key rewrite, a new
manifest/upload after the final scan, or a change between a listing and deletion
can evade detection. ETag is compared between scans but is not an atomic delete
precondition. Protected caller ownership, trustworthy clock and enforceable writer
coordination remain activation prerequisites. This implementation does not claim
safety against a hostile concurrent writer. Physical pending-part bounds,
admission, dedicated mount/capacity, restore and operator qualification remain open.

Run `sh test/blob/retention-run.sh` through `chaldea exec --host agent-a`, requesting
`blob-retention-contracts.tap` and `blob-custody-proof.json` as artifacts.
It checks types, selected cleanup and unchanged custody contracts, then the pinned
Garage proof. The added disposable principal bucket contains six completed objects
and three same-key uploads with page size two. It proves both traversals, zero
effects on an overbound scan, successful cleanup and an empty repeat. The Garage
archive digest, bootstrap source pin/acquisition and existing custody/restore proofs
are unchanged. This is source qualification, not authority to activate cleanup.
