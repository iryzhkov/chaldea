# Da Vinci isolated occurrence proof

Run `chaldea exec --host agent-a --artifact davinci-proof.json --artifact davinci-restarted.json -- sh test/davinci/run.sh` from an owned checkout. The runner uses scratch HOME/TMPDIR, locked dependencies, checksum-pinned NATS 2.15.1 and official T3 0.1.0 with the repository's fixture provider. It requires namespace UID0 so the maintained protected-policy loader can enforce root ownership through every ancestor. Hosted CI runs its disposable scratch under /root/.cache/da-vinci-artifacts-messaging-ci so the full policy ancestor chain is root owned; the ordinary runner checkout is user owned. The runner accepts only that exact CI path or its own snapshot scratch and refuses a preexisting scratch directory. No installed host daemon, real provider, Authentik enrollment, operator credential or production broker is used.

The proof is deliberately under `test/davinci`. It has no CLI or deployed entrypoint. The coordinator accepts one fixed signed loopback webhook body. It journals the body hash, published source pin and immutable one-worker assignment before HTTP202. Its worker journals the assignment before invoking the existing `WaitEngine.startSession({threadId,requestId,preset})`. Only the protected preset selects provider, project, prompt, model, inputs and authority. The caller thread is preconfigured locally; it is a wake destination, not an authenticated principal.

The isolated PLACEMENT broker account has distinct assignment/result subjects. The worker cannot publish assignments or manage streams. Fixture administration alone provisions bounded streams and exact-filter durables. Messaging account permissions are separate and are not reused.

Two cases keep one session and native thread per occurrence:

- Successful fixture output remains exact after lost HTTP/admission/T3 replies, coordinator/worker/waits journal reopen, command/result redelivery across broker process restart, and T3 restart after completion.
- T3 is stopped while the fixture provider is running. Its default native restart continuation stays in the same thread. Original-assignment recovery follows that continuation to one final outcome, with no second launch command or replacement thread.

Changed bytes under one webhook identity conflict. Bad signatures and caller-supplied privileges refuse. Result commitment precedes broker ACK; repeated receipts preserve identical session/thread/run identity. Named JSON artifacts include `passed:true` only after all assertions. A failed runner returns an explicitly false record.

## Result adapter correction

Official T3 puts assistant text on an `assistant_message` item node directly beneath the run root. The old session result selector required the text item's node ID to equal the root ID, so a completed official run returned `result_unavailable`. The adapter now accepts that direct child only when the projection proves matching thread, run, root and parent. Native child output and foreign, missing or unproved ancestry remain excluded. `test/unit/session-result.test.ts` covers those boundaries; existing session policy/lifecycle/credential tests remain applicable.

## Qualification boundary

This spike demonstrates the maintained session admission, launch, status/result and completion outbox against official disposable T3. The synthetic provider returns fixed text; it does not inspect source or prove real read-only filesystem/tool confinement. The in-flight restart case uses a held fixture prompt and qualifies the pinned native continuation default. Same-UID operator-context ingress remains accident prevention, not hostile per-thread authorization.

Coordinator and worker are test-owned objects with transactional journal reopen, not installed daemon processes. The transport is loopback, not TLS/WSS. Sixteen rows and SQLite page limits bound the spike; there is no production pruning, schedule cursor, backup restore fence, capacity advertisement, multiworker selection or live enrollment. Assignment hashes are integrity/replay bindings within the authenticated account, not signatures or privilege grants. Native launch uncertainty and preset occupancy remain owned by Chaldea admission.

M4 must implement bounded production scheduling/placement/recovery only after proof decision B. Live activation still needs the existing admission owner's composed qualification and approved profile/provider/helper setup, actual host capacity and broker/ingress configuration. No additional credential mechanism or T3 server is introduced.
