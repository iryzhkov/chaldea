// Real-process lock contention fixture. stdin provides bounded test coordination.
import { AccessState, Clock } from "../../src/access/trust.ts";
import { RunLeases } from "../../src/access/run-lease.ts";
const path = process.argv[2]!, mode = process.argv[3]!;
if (mode === "hold") {
  const state = new AccessState(path);
  state.db.exec("BEGIN IMMEDIATE");
  process.stdout.write("locked\n");
  process.stdin.once("data", () => {
    state.db.exec("COMMIT"); state.close(); process.stdin.pause();
  });
} else {
  const existing = mode === "leases" ? new AccessState(path) : undefined;
  process.stdout.write("ready\n");
  process.stdin.once("data", () => {
    process.stdout.write("opening\n");
    const state = existing ?? new AccessState(path);
    const clock = new Clock(state, () => { throw new Error("constructor must not sample"); });
    new RunLeases(state, clock); state.close();
    process.stdout.write("opened\n"); process.stdin.pause();
  });
}
