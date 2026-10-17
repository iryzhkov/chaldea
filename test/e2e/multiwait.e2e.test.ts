import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { join, resolve } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import * as Effect from "effect/Effect";
import { startDisposableT3, t3Version } from "../helpers/disposable-t3.ts";
import { scratchDir } from "../helpers/scratch.ts";
import { testSocketPath } from "../helpers/socket.ts";
import { ShellWatcher, waitFor, writePrivateFile } from "../helpers/e2e.ts";
import { withClient } from "../../src/t3/adapter.ts";
import { startWaitService, callService } from "../../src/waits/service.ts";
import { WakeStore, type Item } from "../../src/wake/store.ts";
import type { WaitConfig } from "../../src/waits/config.ts";

const skip=t3Version()==="t3 v0.1.0"?false:"Needs pinned disposable T3 0.1.0";
if(skip&&process.env.CHALDEA_REQUIRE_E2E==="1")throw new Error(skip);
test("eight waits share one durable T3 message across crashes before send and after receipt", {skip,timeout:180_000},async t=>{
  const dir=scratchDir("mw");
  const t3=await startDisposableT3({scratchRoot:dir.path,scenario:"no-reset",autoResume:false,codex:"available"});
  let watcher:ShellWatcher|undefined,service:Awaited<ReturnType<typeof startWaitService>>|undefined;
  try{
    const token=t3.issueToken(["orchestration:read","orchestration:operate"]);
    const environment=await withClient({serverUrl:t3.serverUrl,token},c=>c["server.getConfig"]({}).pipe(Effect.map(c=>String(c.environment.environmentId))));
    watcher=new ShellWatcher(t3.serverUrl,token);
    const parent=await waitFor("bootstrap parent",()=>watcher!.firstThreadId(),30_000);
    const projection=()=>withClient({serverUrl:t3.serverUrl,token},c=>c["orchestration.getThreadProjection"]({threadId:parent} as never));
    const project=(await projection()).thread.projectId;
    for(const boundary of ["before_send","after_send"]){
      await t.test(boundary,async()=>{
        const root=join(dir.path,boundary);mkdirSync(root);
        const config:WaitConfig={environment,t3BaseDir:t3.baseDir,serverUrl:t3.serverUrl,
          tokenFile:join(root,"token"),database:join(root,"db"),socket:testSocketPath(join(root,"s")),
          listenAddress:"127.0.0.1",port:0,answerBaseUrl:"http://127.0.0.1:7385",
          answerTokenFile:join(root,"answer"),logFile:join(root,"log")};
        writePrivateFile(config.tokenFile,token);writePrivateFile(config.answerTokenFile,"fake-answer");
        const path=join(root,"config.json");writeFileSync(path,JSON.stringify(config));
        let store=new WakeStore(config.database,environment);
        const now=Date.now();
        const rows=Array.from({length:8},(_,i)=>store.register(store.prepare("wait",{
          threadId:parent,requestId:now+":"+boundary+i,condition:{kind:"time",at:new Date(now).toISOString()},
        }),project,null));
        for(const [i,row] of rows.entries())store.resolve(row.id,{reason:i%2?"timeout":"time"});
        store.close();
        const child=spawn(process.execPath,[resolve("test/helpers/waits-process.ts"),path,boundary],{stdio:["ignore","pipe","pipe"]});
        let err="";child.stderr.on("data",b=>err+=b);
        const exit=await new Promise<{code:number|null;signal:string|null}>((done,reject)=>{
          child.once("error",reject);child.once("exit",(code,signal)=>done({code,signal}));
        });
        assert.equal(exit.signal,"SIGKILL",err);
        store=new WakeStore(config.database,environment);
        const frozen=store.deliveries();
        assert.equal(frozen.length,8);assert.ok(frozen.every(d=>d.state==="pending"&&d.attempts===1));
        assert.equal(new Set(frozen.map(d=>d.payload)).size,1);
        const command=JSON.parse(frozen[0]!.payload);
        store.close();
        const delivered=Promise.withResolvers<void>();
        service=await startWaitService(config,{boundary(name){if(name==="delivered")delivered.resolve();}});
        await delivered.promise;
        assert.ok(service.store.deliveries().every(d=>d.state==="sent"&&d.attempts===2));
        const messages=(await projection()).messages.filter(m=>m.id===command.messageId);
        assert.equal(messages.length,1);
        assert.equal(messages[0]!.text,command.text);
        for(const row of rows){
          assert.ok(messages[0]!.text.includes(row.id));
          assert.equal(service.store.get(row.id).state,"resolved");
        }
        // Exercise omitted requestId through the actual IPC server, then clean up.
        const input={threadId:parent,condition:{kind:"time",at:new Date(Date.now()+86_400_000).toISOString()}};
        const a=await callService(config.socket,"chaldea_wait",input) as Item;
        const b=await callService(config.socket,"chaldea_wait",input) as Item;
        assert.notEqual(a.id,b.id);assert.match(a.request_key,/^\d{13}:[a-f0-9-]+$/);
        const retry=await callService(config.socket,"chaldea_wait",JSON.parse(a.input)) as Item;
        assert.equal(retry.id,a.id);
        service.engine.cancel(a.id);service.engine.cancel(b.id);
        await service.stop();service=undefined;
        service=await startWaitService(config);
        assert.deepEqual(service.store.dispatchable(),[]);
        assert.equal((await projection()).messages.filter(m=>m.id===command.messageId).length,1);
        await service.stop();service=undefined;
      });
    }
  }finally{await service?.stop();await watcher?.close();await t3.stop();dir.remove();}
});
