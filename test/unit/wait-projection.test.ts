import assert from "node:assert/strict";
import { test } from "node:test";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { readProjection } from "../../src/t3/waits.ts";
import { OrchestrationV2GetThreadProjectionError } from "../../vendor/t3-contracts/src/index.ts";

test("projection errors need positive shell evidence before classifying deletion",async()=>{
  const failure=new OrchestrationV2GetThreadProjectionError({threadId:"parent" as never,message:"Temporary projection read failed"});
  const client=(threads:unknown[],shellFails=false)=>({
    "orchestration.getThreadProjection":()=>Effect.fail(failure),
    "orchestration.subscribeShell":()=>shellFails?Stream.fail(new Error("Shell unavailable")):
      Stream.make({kind:"snapshot",snapshot:{threads,archivedThreads:[]}}),
  }) as never;
  await assert.rejects(Effect.runPromise(readProjection(client([{id:"parent",deletedAt:null}]),"parent")),/Temporary/);
  await assert.rejects(Effect.runPromise(readProjection(client([],true),"parent")),/Shell unavailable/);
  assert.equal(await Effect.runPromise(readProjection(client([]),"parent")),null);
  assert.equal(await Effect.runPromise(readProjection(client([{id:"parent",deletedAt:{}}]),"parent")),null);
});
