import { spawn, spawnSync } from "node:child_process";

/** fd 3 inherits the open file description. The caller retains it until release. */
export function flockSync(fd: number): "locked" | "busy" {
  const result = spawnSync("flock", ["--exclusive", "--nonblock", "3"], {
    stdio: ["ignore", "ignore", "pipe", fd], timeout: 5000,
  });
  if (result.status === 1) return "busy";
  if (result.error || result.status !== 0) throw new Error("Cannot acquire wake database owner lock (Linux flock required)");
  return "locked";
}
export async function flock(fd: number): Promise<void> {
  const child = spawn("/usr/bin/flock", ["-x", "3"], { stdio: ["ignore", "ignore", "pipe", fd] });
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject); child.once("close", resolve);
  });
  if (code !== 0) throw new Error("local accounting lock failed (flock exit " + code + ")");
}
