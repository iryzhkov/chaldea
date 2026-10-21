# Isolated artifact custody proof

Run `chaldea exec --host agent-a --artifact blob-custody-proof.json -- sh test/blob/run.sh` from an owned checkout. This test uses a new asserted snapshot HOME/TMPDIR, refuses preexisting scratch, binds Garage to loopback and removes its synthetic keys, metadata and data on exit. It downloads the exact Garage 2.4.1 OCI digest proposed in infra PR10, verifies the index/manifest/config/layer and extracts only the bounded regular executable. It uses no installed service, live credential or NAS.

The unchanged test-only bootstrap vendor is pinned to infra commit `730491fb9d63ba3e788011a00b15495d8bb53dd9`, Git blob `61e2e824fb749fb31631eea7a80a8d2d95045bc6`. The fixture verifies those source bytes before import and reuses its JSON admin convergence and SigV4 signer. A local binary adapter replaces only its Docker transport. The original broad bucket configuration is not adopted: two separate principal buckets and synthetic least privilege keys exercise isolation. A second convergence must be unchanged.

A representative producer writes one named report inside its own scratch HOME. Publication creates content-addressed objects and a content-addressed manifest bound to job UUID, principal, original relative path, size, digest and expiry. Custody is read back before removing the producer directory. A new reader resolves the job UUID without the producer journal. It rejects missing, conflicting, corrupted or expired manifests and corrupted object bytes. There is no mutable latest pointer or new index service.

The probe also checks read-only and cross-principal denials, completed multipart transfer, abandoned multipart cleanup, object quota refusal, backend outage, stopped data-plus-metadata backup/restore, permission preservation and idempotent protected cleanup after a writer deletes lifecycle configuration. Retention advances an injected clock against real server object/upload timestamps; it does not wait fourteen days. The cleanup fixture refuses truncated or over-bound listings before deleting anything. Its 32-row limit fits only the isolated 16-object fixture and is not a production pagination policy.

## Measured limits and decision A

The pinned Garage accepts `If-None-Match: *` overwrite with HTTP200. Content addressing lets consumers detect changed bytes; it does not make the backend immutable or prevent deletion by an authorized writer. More than one manifest for a job is a conflict, never an instruction to select the newest.

A write-only bucket key can delete lifecycle configuration (HTTP204). Retention therefore needs an independently protected cleanup owner and fixed age policy; writer-configured lifecycle alone is insufficient.

A 2 MiB ordinary object exceeds the fixture's 1 MiB bucket quota and is refused (HTTP403), while an incomplete 2 MiB multipart part is accepted (HTTP200). Logical bucket quotas alone do not bound physical pending-part bytes. Bounded admitted producers, trusted abort cleanup and an independently enforced physical storage limit must be qualified before activation. No credential is passed into the producer.

This source is an isolated decision probe under `test/blob`, with no production CLI, service, timer or default publication path. It does not yet wire ordinary SSH exec artifacts, qualify supported live credential issuance, deploy protected cleanup or prove actual NAS mount/capacity, power-loss recovery, online backup, HA or multi-host access. The stopped backup includes both metadata and object data on the same disposable host. Decision A remains open until enforceable physical bounds, protected cleanup, canonical mount/restore and a real exec round trip are qualified. Existing 32-file/64 MiB exec limits and last-local-copy custody rules remain unchanged.
