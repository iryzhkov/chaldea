import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

/** One host calendar timer, reconstructed from SQLite on every transition/restart. */
export class Deadlines {
  private child: ChildProcess | undefined;
  private at: number | undefined;
  arm(at: number | undefined, fire: () => void, failure: () => void): void {
    if (this.at === at) return;
    this.clear(); this.at = at;
    if (at === undefined) return;
    const child = spawn("python3",[fileURLToPath(new URL("./calendar.py",import.meta.url)),String(Math.max(1,Math.ceil(at)))],
      {stdio:"ignore"});
    this.child = child;
    child.once("error",() => { if (this.child === child) { this.child=undefined; this.at=undefined; failure(); } });
    child.once("exit",(code) => {
      if (this.child !== child) return;
      this.child=undefined; this.at=undefined;
      if (code === 0) fire(); else failure();
    });
  }
  clear(): void { const child=this.child; this.child=undefined; this.at=undefined; child?.kill(); }
}
