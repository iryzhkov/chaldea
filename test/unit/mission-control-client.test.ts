import test from "node:test";
import assert from "node:assert/strict";
const { projectClientSnapshot } = await import(new URL("../../src/mission-control/static/client.js",import.meta.url).href);
const sample=()=>({now:1_000_000,source:{state:"live",observedAt:0},agents:[{id:"agent-0",activityFreshness:"live",detailObservedAt:0}],quota:{state:"cached"},truncated:false});
test("browser ages last heartbeat, marks error or timeout disconnected, and restores only on a fresh snapshot",()=>{
  const raw=sample();
  let view=projectClientSnapshot(raw,1_010_000,true);
  assert.equal(view.agents[0].detailObservedAt,1_000_000);
  assert.equal(view.agents[0].activityFreshness,"live");
  view=projectClientSnapshot(raw,1_010_000,false);
  assert.equal(view.agents[0].activityFreshness,"disconnected");
  assert.equal(view.source.state,"disconnected");
  assert.equal(view.agents[0].detailObservedAt,1_000_000);
  view=projectClientSnapshot(raw,1_031_000,true);
  assert.equal(view.agents[0].activityFreshness,"disconnected");
  assert.equal(view.source.state,"disconnected");
  assert.equal(projectClientSnapshot(raw,4_600_000,false).agents[0].detailObservedAt,1_000_000);
  assert.equal(raw.agents[0]!.activityFreshness,"live");
  const fresh={...raw,now:4_600_000};
  assert.equal(projectClientSnapshot(fresh,4_601_000,true).agents[0].activityFreshness,"live");
  assert.equal(projectClientSnapshot(fresh,4_601_000,true).agents[0].detailObservedAt,4_600_000);
});
test("upstream detail disconnect and its timestamp survive browser reconnection",()=>{
  const raw=sample();raw.agents[0]!.activityFreshness="stale";raw.agents[0]!.detailObservedAt=900_000;
  assert.equal(projectClientSnapshot(raw,1_001_000,true).agents[0].activityFreshness,"stale");
  assert.equal(projectClientSnapshot(raw,1_001_000,true).agents[0].detailObservedAt,900_000);
});
