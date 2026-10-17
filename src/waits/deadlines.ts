import { spawn, type ChildProcess } from "node:child_process";
import { backoff } from "../retry.ts";
import { fileURLToPath } from "node:url";

/** One host calendar timer, reconstructed from SQLite on every transition/restart. */
export class Deadlines {
  private child: ChildProcess | undefined;
  private retry: NodeJS.Timeout | undefined;
  private at: number | undefined;
  private failures=0;
  /** Diagnostics/test access to the owned helper, never another host process. */
  get processId(): number | undefined { return this.child?.pid; }
  arm(at: number | undefined, fire: () => void, failure: () => void): void {
    if (this.at === at) return;
    this.clear(); this.at = at;
    if (at === undefined) return;
    const launch=() => {
      const child = spawn("python3",[fileURLToPath(new URL("./calendar.py",import.meta.url)),String(Math.max(1,Math.ceil(at)))],
        {stdio:"ignore"});
      this.child = child;
      const failed=() => {
        if (this.child !== child) return;
        this.child=undefined; failure();
        this.retry=setTimeout(() => { this.retry=undefined; launch(); },backoff(this.failures++));
      };
      child.once("error",failed);
      child.once("exit",(code) => {
        if (this.child !== child) return;
        if (code !== 0) { failed(); return; }
        this.child=undefined; this.at=undefined; this.failures=0; fire();
      });
    };
    launch();
  }
  clear(): void {
    const child=this.child; this.child=undefined; this.at=undefined; this.failures=0;
    clearTimeout(this.retry); this.retry=undefined; child?.kill();
  }
}
