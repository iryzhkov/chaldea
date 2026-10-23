import { test } from "node:test";
import assert from "node:assert/strict";
import { timesyncdHealth, sampleClock } from "../../src/access/maintenance.ts";
import { readFileSync, writeFileSync, existsSync, symlinkSync, chmodSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { scratchDir } from "../helpers/scratch.ts";
test("ignored replies retain only recent accepted evidence across sampler invocations", () => {
  const scratch = scratchDir("timesyncd-cache");
  try {
    const cache = join(scratch.path, "accepted.json");
    const at = Math.floor(Date.now() / 1000);
    let message = report(0.002, 0, 0.08, at), sync = "b true";
    const run = (program: string, args: string[]) => {
      if (program.endsWith("systemctl")) return "active";
      if (args.at(-1) === "NTPSynchronized") return sync;
      if (args.at(-1) === "NTPMessage") return message;
      return "t 2048000000";
    };
    assert.equal(sampleClock(run, cache).healthy, true);
    const accepted = readFileSync(cache, "utf8");
    // A discarded spike must not replace the last accepted offset or renew its lifetime.
    message = report(1000, 0, 0.08, at).replace(" false ", " true ").replace(" 5 100", " 6 100");
    const fallback = sampleClock(run, cache);
    assert.equal(fallback.healthy, true);
    assert.ok(Math.abs(fallback.offsetSeconds - 0.002) < 0.000001);
    assert.equal(readFileSync(cache, "utf8"), accepted);
    assert.equal(sampleClock(run, join(scratch.path, "missing")).healthy, false);
    sync = "b false";
    assert.equal(sampleClock(run, cache).healthy, false);
    sync = "b true";
    const saved = JSON.parse(accepted);
    for (const patch of [
      { report: report(0.002, 3601, 0.08, at) },
      { bootId: "different-boot" },
      { report: report(0.002, 0, 0.08, at).replace(" 5 100", " 7 100") },
      { monotonicSeconds: 1e15 },
      { sampledAt: at + 60 },
      { sampledAt: at - 60 },
      { report: message },
    ]) {
      writeFileSync(cache, JSON.stringify({ ...saved, ...patch }));
      assert.equal(sampleClock(run, cache).healthy, false, JSON.stringify(patch));
    }
    writeFileSync(cache, accepted);
    message = "unknown NTP layout";
    assert.equal(sampleClock(run, cache).healthy, false);
    // A newly accepted but inaccurate measurement also fails closed.
    message = report(1000, 0, 0.08, at);
    assert.equal(sampleClock(run, cache).healthy, false);
    message = message.replace(" false ", " true ").replace(" 5 100", " 6 100");
    assert.equal(sampleClock(run, cache).healthy, false);
  } finally { scratch.remove(); }
});
test("expired evidence cannot revive after a small backward wall correction", t => {
  const scratch = scratchDir("timesyncd-expiry");
  const at = Math.floor(Date.now() / 1000);
  let wall = at * 1000;
  t.mock.method(Date, "now", () => wall);
  try {
    const cache = join(scratch.path, "accepted.json");
    let message = report(0.002, 191, 0.08, at);
    const run = (program: string, args: string[]) => {
      if (program.endsWith("systemctl")) return "active";
      if (args.at(-1) === "NTPSynchronized") return "b true";
      if (args.at(-1) === "NTPMessage") return message;
      return "t 64000000";
    };
    assert.equal(sampleClock(run, cache).healthy, true);
    message = message.replace(" false ", " true ").replace(" 5 100", " 6 100");
    assert.equal(sampleClock(run, cache).healthy, true);
    wall += 3000;
    assert.equal(sampleClock(run, cache).healthy, false);
    assert.equal(existsSync(cache), false);
    wall -= 2000;
    assert.equal(sampleClock(run, cache).healthy, false);
  } finally { scratch.remove(); }
});
test("accepted evidence crosses Node processes and rejects unsafe cache files", () => {
  const scratch = scratchDir("timesyncd-process");
  try {
    const cache = join(scratch.path, "accepted.json");
    const at = Math.floor(Date.now() / 1000);
    const code = `
      import { sampleClock } from ${JSON.stringify(new URL("../../src/access/maintenance.ts", import.meta.url).href)};
      const run = (program, args) => program.endsWith("systemctl") ? "active" :
        args.at(-1) === "NTPSynchronized" ? "b true" :
        args.at(-1) === "NTPMessage" ? process.argv[2] : "t 64000000";
      console.log(JSON.stringify(sampleClock(run, process.argv[1])));
    `;
    const sample = (message: string) => JSON.parse(execFileSync(process.execPath,
      ["--input-type=module", "-e", code, cache, message], { encoding: "utf8" }));
    const accepted = report(0.002, 0, 0.08, at);
    const ignored = report(1000, 0, 0.08, at).replace(" false ", " true ").replace(" 5 100", " 6 100");
    assert.equal(sample(accepted).healthy, true);
    for (let i = 0; i < 3; i++) assert.equal(sample(ignored).healthy, true);
    chmodSync(cache, 0o666);
    assert.equal(sample(ignored).healthy, false);
    assert.equal(sample(accepted).healthy, true);
    const target = join(scratch.path, "target");
    writeFileSync(target, readFileSync(cache));
    // atomic replacement replaces an existing link safely; fallback never reads it.
    const link = join(scratch.path, "link");
    symlinkSync(target, link);
    const run = (program: string, args: string[]) => program.endsWith("systemctl") ? "active" :
      args.at(-1) === "NTPSynchronized" ? "b true" :
      args.at(-1) === "NTPMessage" ? ignored : "t 64000000";
    assert.equal(sampleClock(run, link).healthy, false);
    assert.equal(existsSync(target), true);
    assert.equal(sample(report(1000, 0, 0.08, at)).healthy, false);
    assert.equal(existsSync(cache), false);
    assert.equal(sample(ignored).healthy, false);
  } finally { scratch.remove(); }
});
const now = 1792252800;
function report(offset = 0.002, age = 0, trip = 0.08, at = now): string {
  const dest = (at - age) * 1e6, origin = dest - (trip + 0.02) * 1e6;
  return "(uuuuittayttttbtt) " + [0,4,4,2,-20,1000,1000,4,1,2,3,4,
    origin, origin + trip / 2 * 1e6 + offset * 1e6, dest - trip / 2 * 1e6 + offset * 1e6, dest, false, 5, 100].join(" ");
}
const health = (r = report(), sync = "b true", poll = "t 64000000") => timesyncdHealth(sync,r,poll,now);
test("timesyncd reads the typed NTP offset and conservative 30 second accuracy bound", () => {
  assert.equal(health().healthy, true);
  assert.ok(Math.abs(health().offsetSeconds - 0.002) < 0.000001);
  assert.equal(health(report(-29)).healthy, true);
  assert.equal(health(report(31)).healthy, false);
  assert.equal(health(report(30)).healthy, false);
  assert.equal(health(report(27,0,8)).healthy, false);
  assert.equal(health(report(0,0,-0.01)).healthy, false);
});
test("timesyncd fails closed for unsynchronised, unknown, stale and ignored measurements", () => {
  for (const sync of ["b false", "", "yes"]) assert.equal(health(report(),sync).healthy,false);
  for (const r of ["",report().replace(" 0 4 4 2 "," 3 4 4 2 "),report().replace(" 0 4 4 2 "," 1 4 4 2 "),report().replace(" 0 4 4 2 "," 0 4 4 16 "),
    report().replace(" false "," true "),report().replace(" 4 1 2 3 4 "," 4 0 0 0 0 "),
    report(0,193),report(0,-31),report().replace(" 5 100"," 0 100"),report()+" extra"]) assert.equal(health(r).healthy,false,r);
  for (const poll of ["", "t 0","t NaN"]) assert.equal(health(report(),"b true",poll).healthy,false);
});
test("active timesyncd never falls back to chrony on failed or unknown status", () => {
  for (const value of ["b false","b true"]) {
    const calls: string[] = [];
    const h = sampleClock((program,args) => {
      calls.push(program);
      if (program.endsWith("systemctl")) return "active\n";
      if (args.at(-1) === "NTPSynchronized") return value;
      if (args.at(-1) === "NTPMessage") throw new Error("bus unavailable");
      return "t 64000000";
    });
    assert.equal(h.healthy,false);
    assert.equal(calls.some(p=>p.endsWith("chronyc")),false);
  }
  assert.equal(sampleClock(()=>{throw new Error("timeout");}).healthy,false);
  assert.equal(sampleClock(()=>"failed").healthy,false);
});
test("active timesyncd samples the exact system D-Bus properties", () => {
  const calls: string[][] = [];
  const h = sampleClock((program,args) => {
    calls.push([program,...args]);
    if (program.endsWith("systemctl")) return "active";
    if (args.at(-1) === "NTPSynchronized") return "b true";
    if (args.at(-1) === "NTPMessage") return report(0.002,0,0.08,Math.floor(Date.now()/1000));
    return "t 64000000";
  });
  assert.equal(h.healthy,true);
  assert.deepEqual(calls.slice(1), [
    ["/usr/bin/busctl","--system","--no-pager","get-property","org.freedesktop.timedate1",
      "/org/freedesktop/timedate1","org.freedesktop.timedate1","NTPSynchronized"],
    ["/usr/bin/busctl","--system","--no-pager","get-property","org.freedesktop.timesync1",
      "/org/freedesktop/timesync1","org.freedesktop.timesync1.Manager","NTPMessage"],
    ["/usr/bin/busctl","--system","--no-pager","get-property","org.freedesktop.timesync1",
      "/org/freedesktop/timesync1","org.freedesktop.timesync1.Manager","PollIntervalUSec"]]);
});
test("inactive timesyncd retains chrony's protected socket adapter", () => {
  let args: string[] = [];
  const h = sampleClock((program,a) => {
    if (program.endsWith("systemctl")) return "inactive";
    args = a; return "invalid tracking";
  });
  assert.equal(h.healthy,false);
  assert.deepEqual(args,["-n","-h","/run/chrony/chronyd.sock","tracking"]);
});
