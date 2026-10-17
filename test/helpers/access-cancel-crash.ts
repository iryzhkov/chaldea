// Test-only child: cancel durably, then die without cleanup.
import { AccessState, Clock } from "../../src/access/trust.ts";
import { RunLeases } from "../../src/access/run-lease.ts";
const state = new AccessState(process.argv[2]!);
const clock = new Clock(state, () => { throw new Error("cancellation must not read the clock"); });
new RunLeases(state, clock).cancel(process.argv[3]!);
process.kill(process.pid, "SIGKILL");
