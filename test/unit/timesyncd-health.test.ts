import { test } from "node:test";
import assert from "node:assert/strict";
import { timesyncdHealth, sampleClock } from "../../src/access/maintenance.ts";
const now = 1792252800;
function report(offset = 0.002, age = 0): string {
  const dest = (now - age) * 1e6, origin = dest - 100000;
  return "(uuuuittayttttbtt) " + [0,4,4,2,-20,1000,1000,4,1,2,3,4,
    origin, origin + 40000 + offset * 1e6, dest - 40000 + offset * 1e6, dest, false, 5, 100].join(" ");
}
const health = (r = report(), sync = "b true", poll = "t 64000000") => timesyncdHealth(sync,r,poll,now);
test("timesyncd reads the typed NTP offset and conservative 30 second accuracy bound", () => {
  assert.equal(health().healthy, true);
  assert.ok(Math.abs(health().offsetSeconds - 0.002) < 0.000001);
  assert.equal(health(report(-29)).healthy, true);
  assert.equal(health(report(31)).healthy, false);
  assert.equal(health(report(30)).healthy, false);
});
test("timesyncd fails closed for unsynchronised, unknown, stale and ignored measurements", () => {
  for (const sync of ["b false", "", "yes"]) assert.equal(health(report(),sync).healthy,false);
  for (const r of ["",report().replace(" 0 4 4 2 "," 3 4 4 2 "),report().replace(" 0 4 4 2 "," 0 4 4 16 "),
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
test("inactive timesyncd retains chrony's protected socket adapter", () => {
  let args: string[] = [];
  const h = sampleClock((program,a) => {
    if (program.endsWith("systemctl")) return "inactive";
    args = a; return "invalid tracking";
  });
  assert.equal(h.healthy,false);
  assert.deepEqual(args,["-n","-h","/run/chrony/chronyd.sock","tracking"]);
});
