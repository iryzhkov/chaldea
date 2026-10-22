import assert from "node:assert/strict";
import { test } from "node:test";
import { finalAssistant, readFinalAssistant, type ResultProjection, type ResultItem } from "../../src/session/t3.ts";
import { checkResult } from "../../src/session/result.ts";

// Official 0.1.0 gives assistant text its own provider item node, under the
// run root. Same-run native child output is never the root reporter's result.
test("result follows a proved main assistant node, excluding native children and foreign ancestry", () => {
  const item = (id:string,nodeId:string,ordinal:number) => ({type:"assistant_message",id,threadId:"thread",runId:"run",
    nodeId,ordinal,status:"completed",streaming:false,text:id});
  const node = (id:string,over:Record<string,unknown>={}) => ({id,threadId:"thread",runId:"run",
    status:"completed",kind:"assistant_message",rootNodeId:"root",parentNodeId:"root",...over});
  const p = {
    thread:{id:"thread"},runs:[{id:"run",threadId:"thread",rootNodeId:"root",status:"completed"}],
    nodes:[node("root",{kind:"root_turn",parentNodeId:null}),node("main"),node("child",{kind:"subagent"}),node("child-message",{parentNodeId:"child"}),
      node("foreign",{threadId:"other"}),node("wrong-run",{runId:"other"}),node("unknown",{parentNodeId:"absent"})],
    turnItems:[item("main text","main",1),item("child text","child-message",2),item("foreign text","foreign",3),
      item("wrong run text","wrong-run",4),item("unknown text","unknown",5)],
  };
  assert.deepEqual(finalAssistant(p as ResultProjection,"thread","run"),{kind:"found",text:"main text",itemId:"main text"});
  for (const id of ["child-message","foreign","wrong-run","unknown"]) {
    assert.deepEqual(finalAssistant({...p,turnItems:[item("bad",id,1)]} as ResultProjection,"thread","run"),{kind:"missing"});
  }
  assert.deepEqual(finalAssistant({...p,nodes:[],turnItems:[item("unproved","main",1)]} as ResultProjection,"thread","run"),{kind:"ambiguous",detail:"root_node_invalid"});
  assert.deepEqual(finalAssistant({...p,turnItems:[{...item("partial","main",1),streaming:true}]} as ResultProjection,"thread","run"),
    {kind:"ambiguous",detail:"streaming"});
});

function officialResult(text = "exact ✓\n"): ResultProjection {
  return {
    thread: { id: "thread" },
    runs: [{ id: "run", threadId: "thread", rootNodeId: "root", status: "completed" }],
    nodes: [
      { id: "root", threadId: "thread", runId: "run", parentNodeId: null, rootNodeId: "root", kind: "root_turn", status: "completed" },
      { id: "assistant", threadId: "thread", runId: "run", parentNodeId: "root", rootNodeId: "root", kind: "assistant_message", status: "completed" },
    ],
    turnItems: [{
      id: "turn-item:provider:claudeAgent:native-item:fixture", type: "assistant_message", threadId: "thread", runId: "run",
      nodeId: "assistant", ordinal: 39, status: "completed", streaming: false, text,
    }],
  };
}
const result = (text: string) => ({ kind: "found", text, itemId: officialResult().turnItems[0]!.id });

test("official completed assistant item belongs to an immediate child of the run root", () => {
  const p = officialResult();
  assert.equal(p.turnItems.filter(i => i.nodeId === p.runs[0]!.rootNodeId).length, 0);
  assert.deepEqual(finalAssistant(p, "thread", "run"), result("exact ✓\n"));
});

test("owned candidate point read recovers exact text and validates the requested IDs", async () => {
  const p = officialResult(), item = p.turnItems[0]!;
  // Missing text is a defensive boundary case, not a demonstrated official RPC shape.
  const { text: _text, ...metadata } = item;
  const withoutText = { ...p, turnItems: [metadata] };
  assert.deepEqual(finalAssistant(withoutText, "thread", "run"), { kind: "missing" });
  let calls = 0;
  assert.deepEqual(await readFinalAssistant(withoutText, "thread", "run", async (threadId, itemId) => {
    calls++; assert.equal(threadId, "thread"); assert.equal(itemId, item.id); return item;
  }), result("exact ✓\n"));
  assert.equal(calls, 1);
});

test("foreign projection/run/node/type and native child output never supply a candidate", async () => {
  const p = officialResult(), item = p.turnItems[0]!, node = p.nodes![1]!;
  const variants: ResultProjection[] = [
    { ...p, thread: { id: "foreign" } },
    { ...p, runs: [{ ...p.runs[0]!, threadId: "foreign" }] },
    { ...p, runs: [{ ...p.runs[0]!, status: "running" }] },
    { ...p, runs: [...p.runs, ...p.runs] },
    { ...p, nodes: [{ ...p.nodes![0]!, status: "running" }, node] },
    { ...p, nodes: [p.nodes![0]!, { ...node, threadId: "foreign" }] },
    { ...p, nodes: [p.nodes![0]!, { ...node, runId: "foreign" }] },
    { ...p, nodes: [p.nodes![0]!, { ...node, parentNodeId: "native-child" }] },
    { ...p, nodes: [p.nodes![0]!, { ...node, rootNodeId: "foreign" }] },
    { ...p, nodes: [p.nodes![0]!, { ...node, kind: "subagent" }] },
    { ...p, nodes: [p.nodes![0]!, { ...node, status: "running" }] },
    ...[{ threadId: "foreign" }, { runId: "foreign" }, { nodeId: "foreign" }, { type: "reasoning" },
      { streaming: true }, { status: "running" }].map(patch => ({ ...p, turnItems: [{ ...item, ...patch }] })),
    { ...p, turnItems: [item, { ...item, id: "second" }] },
    { ...p, turnItems: [item, { ...item, ordinal: 40 }] },
  ];
  for (const variant of variants) {
    const read = await readFinalAssistant(variant, "thread", "run", async () => { assert.fail("must not point read"); });
    assert.notEqual(read.kind, "found");
  }
});

test("point read refuses foreign identity, type, ordinal, streaming and nonterminal items", async () => {
  const p = officialResult(), item = p.turnItems[0]!;
  const patches: Partial<ResultItem>[] = [{ id: "foreign" }, { threadId: "foreign" }, { runId: "foreign" },
    { nodeId: "foreign" }, { type: "dynamic_tool" }, { ordinal: 40 }, { streaming: true }, { status: "running" }];
  for (const patch of patches) {
    const read = await readFinalAssistant(p, "thread", "run", async () => ({ ...item, ...patch }));
    assert.equal(read.kind, "ambiguous");
  }
  for (const key of ["status", "streaming"] as const) {
    const incomplete = { ...item }; delete incomplete[key];
    assert.equal((await readFinalAssistant(p, "thread", "run", async () => incomplete)).kind, "ambiguous");
  }
  assert.deepEqual(await readFinalAssistant(p, "thread", "run", async () => null), { kind: "missing" });
});

test("no safe candidate ID remains unavailable; network failure propagates", async () => {
  const p = officialResult();
  assert.deepEqual(await readFinalAssistant({ ...p, turnItems: [] }, "thread", "run", async () => {
    assert.fail("must not guess an ID");
  }), { kind: "missing" });
  const failure = new Error("network unavailable");
  await assert.rejects(readFinalAssistant(p, "thread", "run", async () => { throw failure; }), e => e === failure);
});

test("point read keeps 2411 bytes explicit oversize; 2048 UTF-8 bytes remain exact", async () => {
  for (const text of ["x".repeat(2411), "é".repeat(1024)]) {
    const p = officialResult(text), read = await readFinalAssistant(p, "thread", "run", async () => p.turnItems[0]!);
    assert.equal(read.kind, "found");
    if (read.kind !== "found") assert.fail("found");
    assert.equal(read.text, text);
    assert.deepEqual(checkResult(read.text), Buffer.byteLength(text) === 2411
      ? { state: "result_oversize", bytes: 2411 } : { state: "stored", text, bytes: 2048 });
  }
});
