import { test } from "node:test";
import assert from "node:assert/strict";
import { timesyncdHealth, sampleClock } from "../../src/access/maintenance.ts";
import { readFileSync, writeFileSync } from "node:fs";
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
    message = report(1000, 0, 0.08, at).replace(" false ", " true ");
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
      { monotonicSeconds: 1e15 },
      { sampledAt: at + 60 },
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
    message = message.replace(" false ", " true ");
    assert.equal(sampleClock(run, cache).healthy, false);
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
