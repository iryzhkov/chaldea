import assert from "node:assert/strict";
import { test } from "node:test";
import { finalAssistant, type ResultProjection } from "../../src/session/t3.ts";

// Official 0.1.0 gives assistant text its own provider item node, under the
// run root. Same-run native child output is never the root reporter's result.
test("result follows a proved main assistant node, excluding native children and foreign ancestry", () => {
  const item = (id:string,nodeId:string,ordinal:number) => ({type:"assistant_message",id,threadId:"thread",runId:"run",
    nodeId,ordinal,streaming:false,text:id});
  const node = (id:string,over:Record<string,unknown>={}) => ({id,threadId:"thread",runId:"run",
    kind:"assistant_message",rootNodeId:"root",parentNodeId:"root",...over});
  const p = {
    thread:{id:"thread"},runs:[{id:"run",threadId:"thread",rootNodeId:"root"}],
    nodes:[node("main"),node("child",{kind:"subagent"}),node("child-message",{parentNodeId:"child"}),
      node("foreign",{threadId:"other"}),node("wrong-run",{runId:"other"}),node("unknown",{parentNodeId:"absent"})],
    turnItems:[item("main text","main",1),item("child text","child-message",2),item("foreign text","foreign",3),
      item("wrong run text","wrong-run",4),item("unknown text","unknown",5)],
  };
  assert.deepEqual(finalAssistant(p as ResultProjection,"thread","run"),{kind:"found",text:"main text",itemId:"main text"});
  for (const id of ["child-message","foreign","wrong-run","unknown"]) {
    assert.deepEqual(finalAssistant({...p,turnItems:[item("bad",id,1)]} as ResultProjection,"thread","run"),{kind:"missing"});
  }
  assert.deepEqual(finalAssistant({...p,nodes:[],turnItems:[item("unproved","main",1)]} as ResultProjection,"thread","run"),{kind:"missing"});
  assert.deepEqual(finalAssistant({...p,turnItems:[{...item("partial","main",1),streaming:true}]} as ResultProjection,"thread","run"),
    {kind:"ambiguous",detail:"streaming"});
});
