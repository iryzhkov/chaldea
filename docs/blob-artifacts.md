# Exec artifact custody

The optional $XDG_CONFIG_HOME/chaldea/blob.json enables trusted-client publication after a completed ordinary exec job's local output has synced. Without it the existing SSH/local-artifact workflow is unchanged. No host, credential or service is provisioned by this client. Do not enable a live store before the storage qualification and operator packet are accepted.

Example configuration (paths are literal):

```json
{
  "version": 1,
  "endpoint": "https://artifacts.example",
  "bucket": "artifacts-principal-a",
  "principal": "principal-a",
  "region": "garage",
  "credentialFile": "/home/example/.config/chaldea/garage-key.json"
}
```

Use a principal-specific artifact bucket and an existing Garage-issued read/write key without owner/administration rights for publication. A fresh consumer uses a read-only key for that same bucket and principal. The private target-local credential file contains only {"accessKeyId":"…","secretAccessKey":"…"} and must be owned by the effective UID, mode 0600 or stricter, one regular inode and at most 4096 bytes. The existing descriptor-based trusted reader enforces this. This is a projection of the existing Garage key, not an issuer or renewal service. Credential enrollment, rotation and distribution remain operator work. No key enters the job snapshot or environment.

Only HTTPS origins are accepted, with the normal trust store and hostname verification; literal loopback HTTP supports the isolated fixture/local service. Embedded URL credentials, paths, queries, fragments and redirects refuse. Requests have a 15 second timeout, status errors expose only the HTTP code, and response bytes are bounded. The S3 SigV4 calculation follows the existing pinned bootstrap contract and is exercised against the actual pinned Garage executable.

A pending custody record is written before dispatch. The existing client receives and syncs named artifacts through the unchanged host scanner/path/32 file/64 MiB protocol. Job outcome and exit status remain authoritative even if storage is unavailable. Missing requested names are recorded explicitly in the manifest and reported as unavailable, never synthesized as empty files.

Publication freezes the job/principal/requested paths/actual path-size-SHA256 entries and a 14 day lifetime into the original journal before its first PUT. Objects and manifests are content addressed under v1/JOB-ID/. Every object is read back and verified, then the exact manifest is resolved and verified before custody becomes confirmed. An ambiguous reply is retried with the same frozen manifest and original UUID. Multiple manifests conflict; changed bytes are detected. The backend does not provide immutability against a writer.

A publication failure prints custody pending and retains the last local files and journal. Age and cap pruning cannot evict pending custody. The existing 20 GiB per-host accounting and 1,000 journal entry admission bounds refuse new work when protected entries fill the bound. Pending publication is not retried in a background loop. After recovery:

```sh
chaldea exec artifacts publish ORIGINAL-JOB-ID
```

The retry requires synced output from a finished job, or a completed explicit host-recovery snapshot for other outcomes. Publication never infers an execution outcome. Host recovery and publication share one per-job lock, load the journal after locking, and recovery resets custody to pending. A durable recovery-in-progress barrier blocks publication after a crash during file replacement until host fetch completes again. The frozen manifest survives confirmation: recovery must reconfirm the same artifact set, and changed sets refuse with a frozen-manifest conflict while protecting local bytes. A proven refusal before execution creates no custody obligation. The retry requires the original local journal/files and matching store identity (endpoint, bucket, principal, region). A rotated key may replace the private key file. A frozen draft with changed local bytes or expired lifetime refuses; preserve that local recovery state for operator resolution. Existing exec fetch still means host recovery and does not silently switch transports.

A fresh authorized client needs its own configuration/read-only key and the original UUID, with no producer journal or worktree:

```sh
chaldea exec artifacts fetch ORIGINAL-JOB-ID --output NEW-DIRECTORY
```

The output directory must not exist and its parent must resolve without symlinks. Download verifies manifest identity, expiry, bounds and every artifact digest before reporting success. Failure removes the directory created by this invocation. Existing destinations refuse. A final private .chaldea-blob-receipt.json binds returned files to the manifest; unavailable requested names appear in the JSON command result. A crashed fetch has no success receipt until the final write and can leave an incomplete directory that must be inspected or removed before retry.

## Evidence and remaining qualification

sh test/blob/client-run.sh inside agent-a runs the exec typecheck/unit contracts and the pinned Garage probe. The production CLI and maintained host execute/scan/transfer/cleanup protocol perform the round trip. The fixture substitutes SSH and namespace setup and uses only synthetic keys; it does not qualify filesystem confinement. It also exercises a fresh read-only consumer without the producer journal, explicit unavailable names, storage outage without loss of job success/local bytes, and same-draft retry. Existing real SSH/bubblewrap/pasta CI remains required.

This opt-in source does not activate a service, enroll a host or settle decision A. The measured write-key lifecycle mutation and unbounded pending multipart bytes still require protected cleanup, independent physical storage enforcement, bounded producer admission and verified dedicated mount/capacity/data-plus-metadata restore. Production traversal/retention ownership and the authorized real canary remain open. No larger artifact/secret-scan cap, runtime credential mechanism, index database, new daemon or SSH transport is introduced.
