import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn, type ChildProcess } from "node:child_process";
import { join,resolve } from "node:path";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import * as Effect from "effect/Effect";
import { startDisposableT3,t3Version } from "../helpers/disposable-t3.ts";
import { scratchDir } from "../helpers/scratch.ts";
import { testSocketPath } from "../helpers/socket.ts";
import { ShellWatcher, waitFor,dispatchMessage,writePrivateFile,sleep,runCli } from "../helpers/e2e.ts";
import { withClient } from "../../src/t3/adapter.ts";
import { startWaitService,callService } from "../../src/waits/service.ts";
import { WakeStore, type Item } from "../../src/wake/store.ts";
import type { WaitConfig } from "../../src/waits/config.ts";

const version=t3Version();
const skip=version==="t3 v0.1.0"?false:"Needs pinned disposable T3 0.1.0";
if(skip&&process.env.CHALDEA_REQUIRE_E2E==="1")throw new Error(skip);
const iso=(n:number)=>new Date(n).toISOString();
const key=()=>Date.now()+":"+crypto.randomUUID();
async function until(what:string,probe:()=>Promise<boolean>,timeout=15_000):Promise<void>{
  const end=Date.now()+timeout;
  while(!await probe()){if(Date.now()>end)throw new Error("Timed out: "+what);await sleep(30);}
}
async function processService(config:string,crash?:string):Promise<{child:ChildProcess;stop():Promise<void>}>{
  const child=spawn(process.execPath,[resolve("test/helpers/waits-process.ts"),config,...(crash?[crash]:[])],{
    env:{...process.env,TMPDIR:process.env.TMPDIR!},stdio:["ignore","pipe","pipe"]});
  let out="",err="";child.stdout!.on("data",b=>out+=b);child.stderr!.on("data",b=>err+=b);
  await waitFor("service ready",()=>{if(child.exitCode!==null)throw new Error(err);return out.includes("ready");},15_000);
  return {child,async stop(){if(child.exitCode!==null||child.signalCode!==null)return;
    const ended=new Promise<void>(r=>child.once("exit",()=>r()));child.kill("SIGTERM");await ended;}};
}
test("durable waits and provider-independent decision inbox on disposable T3", {skip,timeout:180_000},async t=>{
  const dir=scratchDir("waits-e2e");
  const t3=await startDisposableT3({scratchRoot:dir.path,scenario:"no-reset",autoResume:false,codex:"available"});
  let service:Awaited<ReturnType<typeof startWaitService>>|undefined;
  let watcher:ShellWatcher|undefined;
  let childService:Awaited<ReturnType<typeof processService>>|undefined;
  try{
    const token=t3.issueToken(["orchestration:read","orchestration:operate"]);
    const environment=await withClient({serverUrl:t3.serverUrl,token},c=>c["server.getConfig"]({}).pipe(Effect.map(c=>String(c.environment.environmentId))));
    watcher=new ShellWatcher(t3.serverUrl,token);
    const parent=await waitFor("bootstrap parent",()=>watcher!.firstThreadId(),30_000);
    const snapshot=()=>withClient({serverUrl:t3.serverUrl,token},c=>c["orchestration.getThreadProjection"]({threadId:parent} as never));
    const wakeCount=async(id:string)=>(await snapshot()).messages.filter(m=>["chaldea-wait:"+id+":wake","chaldea-decision:"+id+":wake"].includes(m.id)).length;
    const config:WaitConfig={environment,t3BaseDir:t3.baseDir,tokenFile:join(dir.path,"t3-token"),database:join(dir.path,"state/wakes.sqlite"),
      socket:testSocketPath(join(dir.path,"service.sock")),listenAddress:"127.0.0.1",port:0,answerBaseUrl:"http://127.0.0.1:7385",
      answerTokenFile:join(dir.path,"answer-token"),logFile:join(dir.path,"state/waits.log")};
    mkdirSync(join(dir.path,"state"));
    writePrivateFile(config.tokenFile,token);writePrivateFile(config.answerTokenFile,"fake-answer-token");
    const configPath=join(dir.path,"config.json");writeFileSync(configPath,JSON.stringify(config));
    const invoke=(method:string,input:unknown)=>callService(config.socket,method,input) as Promise<Item>;
    const waitTime=()=>({threadId:parent,requestId:key(),condition:{kind:"time",at:iso(Date.now()+200)}});
    const ask=(ms=3000)=>({threadId:parent,requestId:key(),question:"Run the dependent step?",options:["Defer","Run"],
      dependentAction:"run the dependent step",defaultAction:"defer",deadline:iso(Date.now()+ms)});
    const wakeTiming=new Map<string,{registered:number;delivered?:number}>();
    service=await startWaitService(config,{boundary:(name,id)=>{
      if(name==="registered")wakeTiming.set(id,{registered:performance.now()});
      if(name==="delivered"){
        const timing=wakeTiming.get(id);if(timing)timing.delivered=performance.now();
      }
    }});
    await t.test("same database refuses a second service even with a different IPC socket",async()=>{
      await assert.rejects(startWaitService({...config,socket:testSocketPath(join(dir.path,"second.sock"))}),/already owned/);
      assert.equal(service!.store.meta("environment"),environment);
    });

    await t.test("time and already-true waits commit exactly one wake",async()=>{
      for(const offset of [200,-1000]){
        const started=Date.now();const input={...waitTime(),description:"Recheck review after reset",condition:{kind:"time",at:iso(started+offset)}};
        const row=await invoke("chaldea_wait",input);
        assert.equal((row as Item & {description:string}).description,input.description);
        assert.equal((await invoke("chaldea_wait",input)).id,row.id);
        await assert.rejects(invoke("chaldea_wait",{...input,description:"changed"}),/changed payload/);
        await until("one time wake",async()=>await wakeCount(row.id)===1);
        await sleep(150);assert.equal(await wakeCount(row.id),1);
        const message=(await snapshot()).messages.find(m=>m.id==="chaldea-wait:"+row.id+":wake")!;
        assert.ok(message.text.includes('Context: "Recheck review after reset"; target time reached'));
        assert.equal((await invoke("chaldea_wait_status",{id:row.id}) as Item & {description:string}).description,input.description);
      }
    });
    await t.test("performance: wake delivery (2 s product target, generous CI guard)",async()=>{
      const row=await invoke("chaldea_wait",{...waitTime(),condition:{kind:"time",at:iso(Date.now()-1)}});
      await until("delivery receipt",async()=>wakeTiming.get(row.id)?.delivered!==undefined);
      const timing=wakeTiming.get(row.id)!;
      const elapsed=timing.delivered!-timing.registered;
      // Measure committed registration through durable delivery receipt, excluding
      // projection polling. The product target stays 2 s; hosted CI gets 5x slack.
      t.diagnostic("wake target=2000ms; CI guard=10000ms; operation="+elapsed+"ms");
      assert.ok(elapsed<10_000,"wake delivery operation exceeded CI guard: "+elapsed);
      assert.equal(await wakeCount(row.id),1);
    });
    await t.test("wake content is marked, short and queued behind active parent work",async()=>{
      const busyId=key();
      await dispatchMessage(t3,token,parent,"keep working chaldea-waits-delay:1800",busyId);
      let activeRun="";
      await until("active parent",async()=>{
        const running=(await snapshot()).runs.find(r=>r.userMessageId==="e2e-message-"+busyId && r.status==="running");
        activeRun=running?.id??"";return Boolean(running);
      });
      const before=(await snapshot()).messages.filter(m=>m.text.startsWith("Chaldea wake")).length;
      const row=await invoke("chaldea_wait",{...waitTime(),condition:{kind:"time",at:iso(Date.now()-1)}});
      await until("queued wake receipt",async()=>await wakeCount(row.id)===1);
      const p=await snapshot();const message=p.messages.find(m=>m.id==="chaldea-wait:"+row.id+":wake")!;
      assert.equal(message.role,"user");
      assert.ok(message.text.startsWith("Chaldea wake (wait "+row.id+")"));
      assert.ok(message.text.includes('"reason":"time"'));
      assert.ok(message.text.includes("Wait until "));
      assert.ok(message.text.includes("target time reached"));
      assert.ok(message.text.endsWith("chaldea wait status "+row.id));
      assert.ok(Buffer.byteLength(message.text)<1024);
      assert.equal(p.messages.filter(m=>m.text.startsWith("Chaldea wake")).length,before+1);
      assert.equal(p.runs.find(r=>r.id===activeRun)?.status,"running");
      assert.equal(p.runs.find(r=>r.userMessageId===message.id)?.status,"queued");
      await until("active parent finishes normally",async()=>(await snapshot()).runs.find(r=>r.id===activeRun)?.status==="completed");
      assert.equal(await wakeCount(row.id),1);
    });
    await t.test("CLI duration retry, status and cancellation round trip",async()=>{
      const requestId=key();
      const args=["wait","time","--after","10s","--description","Check build logs","--thread",parent,"--request-id",requestId,"--config",configPath];
      const first=await runCli(args,dir.path);assert.equal(first.code,0,first.stderr);
      const row=JSON.parse(first.stdout);assert.equal(row.description,"Check build logs");assert.equal(JSON.parse(row.input).description,row.description);const second=await runCli(args,dir.path);
      assert.equal(second.code,0,second.stderr);assert.equal(JSON.parse(second.stdout).id,row.id);
      const status=await runCli(["wait","status",row.id,"--config",configPath],dir.path);
      assert.equal(status.code,0,status.stderr);assert.equal(JSON.parse(status.stdout).id,row.id);assert.equal(JSON.parse(status.stdout).description,row.description);
      const cancel=await runCli(["wait","cancel",row.id,"--config",configPath],dir.path);
      assert.equal(cancel.code,0,cancel.stderr);assert.equal(JSON.parse(cancel.stdout).delivery,"suppressed");
      assert.equal(await wakeCount(row.id),0);
    });
    await t.test("cancel before condition gives no wake",async()=>{
      const row=await invoke("chaldea_wait",{...waitTime(),condition:{kind:"time",at:iso(Date.now()+500)}});
      await invoke("chaldea_wait_cancel",{id:row.id});await sleep(700);assert.equal(await wakeCount(row.id),0);
    });
    await t.test("thread/run wait pins another thread's accepted work and wakes once",async()=>{
      const project=(await snapshot()).thread.projectId;
      const target="wait-target-"+crypto.randomUUID();
      await withClient({serverUrl:t3.serverUrl,token},c=>c["orchestration.dispatchCommand"]({
        type:"thread.create",commandId:key(),threadId:target,projectId:project,title:"Wait target",modelSelection:{instanceId:"claudeAgent",model:"claude-sonnet-4-6"},
        runtimeMode:"full-access",interactionMode:"default",branch:null,worktreePath:null,createdBy:"user",creationSource:"web",
      } as never) as Effect.Effect<unknown,unknown>);
      await dispatchMessage(t3,token,target,"complete this test chaldea-waits-delay:800","target-run");
      const targetSnap=()=>withClient({serverUrl:t3.serverUrl,token},c=>c["orchestration.getThreadProjection"]({threadId:target} as never));
      await until("target accepted run",async()=>(await targetSnap()).runs.length>0);
      const result=await runCli(["wait","thread","--target",target,"--thread",parent,"--description","Collect target result","--config",configPath],dir.path);
      assert.equal(result.code,0,result.stderr);const row=JSON.parse(result.stdout);
      assert.equal(row.description,"Collect target result");
      assert.equal(row.state,"parked");
      await until("thread wake",async()=>await wakeCount(row.id)===1);
      assert.equal(JSON.parse((await invoke("chaldea_wait_status",{id:row.id})).outcome!).reason,"completed");
      const message=(await snapshot()).messages.find(m=>m.id==="chaldea-wait:"+row.id+":wake")!;
      assert.ok(message.text.includes('Context: "Collect target result"; target run completed'));
      await sleep(100);assert.equal(await wakeCount(row.id),1);
    });
    await t.test("answer page and CLI wake once",async()=>{
      const row=await invoke("chaldea_decision_ask",ask(10_000));
      const url="http://127.0.0.1:"+service!.port+"/decisions/"+row.id;
      assert.equal((await fetch(url)).status,401);
      const auth={Authorization:"Basic "+Buffer.from("chaldea:fake-answer-token").toString("base64"),Origin:"null","Sec-Fetch-Site":"same-origin"};
      const page=await fetch(url,{headers:auth});const html=await page.text();
      assert.equal(page.status,200);assert.ok(html.includes("Run the dependent step?"));
      const csrf=/name="csrf" value="([a-f0-9]+)"/.exec(html)![1]!;
      assert.equal((await fetch(url,{method:"POST",headers:auth,body:new URLSearchParams({csrf:"bad",answer:"Run"})})).status,400);
      for(const headers of [{...auth,"Sec-Fetch-Site":"cross-site"},{...auth,"Sec-Fetch-Site":"none"}]){
        const refused=await fetch(url,{method:"POST",headers,body:new URLSearchParams({csrf,answer:"Run"})});
        assert.equal(refused.status,400);assert.match((await refused.json()).error,/origin refused/);
        assert.equal((await invoke("chaldea_decision_status",{id:row.id})).state,"parked");
      }
      const response=await fetch(url,{method:"POST",headers:auth,body:new URLSearchParams({csrf,answer:"Run"}),redirect:"manual"});
      assert.equal(response.status,303);
      await until("answered wake",async()=>await wakeCount(row.id)===1);
      const result=JSON.parse((await invoke("chaldea_decision_status",{id:row.id})).outcome!);
      assert.deepEqual(result,{reason:"answered",answer:"Run",defaulted:false,source:"page"});
      const wake=(await snapshot()).messages.find(m=>m.id==="chaldea-decision:"+row.id+":wake")!;
      assert.equal(wake.role,"user");assert.ok(wake.text.startsWith("Chaldea wake (decision "+row.id+")"));
      assert.ok(wake.text.endsWith("chaldea decision status "+row.id));
      await invoke("chaldea_decision_answer_cli",{id:row.id,answer:"Defer"});assert.equal(await wakeCount(row.id),1);
      const current=await fetch(url,{headers:auth});assert.ok((await current.text()).includes("answered"));
    });
    await t.test("deadline applies safe default; answer/deadline race has one outcome",async()=>{
      const q=await invoke("chaldea_decision_ask",ask(200));
      await until("default wake",async()=>await wakeCount(q.id)===1);
      assert.deepEqual(JSON.parse((await invoke("chaldea_decision_status",{id:q.id})).outcome!),{reason:"deadline",defaulted:true,action:"defer"});
      const race=ask(350);const row=await invoke("chaldea_decision_ask",race);
      await sleep(Math.max(0,Date.parse(race.deadline)-Date.now()));
      await invoke("chaldea_decision_answer_cli",{id:row.id,answer:"Run"});
      await until("race wake",async()=>await wakeCount(row.id)===1);
      const outcome=(await invoke("chaldea_decision_status",{id:row.id})).outcome!;
      await sleep(100);assert.equal((await invoke("chaldea_decision_status",{id:row.id})).outcome,outcome);assert.equal(await wakeCount(row.id),1);
      const concurrent=await invoke("chaldea_decision_ask",ask(10_000));
      const answers=await Promise.all(Array.from({length:8},(_,i)=>invoke("chaldea_decision_answer_cli",{id:concurrent.id,answer:i%2?"Run":"Defer"})));
      assert.equal(new Set(answers.map(a=>a.outcome)).size,1);
      assert.equal(JSON.parse(answers[0]!.outcome!).source,"cli");
      await until("one concurrent answer wake",async()=>await wakeCount(concurrent.id)===1);
    });
    await t.test("CLI and MCP use the same inbox and explicit caller identity",async()=>{
      const q=ask(10000);
      const child=spawn(process.execPath,[resolve("src/cli.ts"),"mcp","--config",configPath],{stdio:["pipe","pipe","pipe"]});
      let data="";let err="";child.stdout.on("data",b=>data+=b);child.stderr.on("data",b=>err+=b);
      const lines=()=>data.trim().split("\n").filter(Boolean).map(s=>JSON.parse(s));
      child.stdin.write(JSON.stringify({jsonrpc:"2.0",id:1,method:"initialize",params:{protocolVersion:"2024-11-05",capabilities:{},clientInfo:{name:"test",version:"1"}}})+"\n");
      child.stdin.write(JSON.stringify({jsonrpc:"2.0",id:2,method:"tools/list"})+"\n");
      child.stdin.write(JSON.stringify({jsonrpc:"2.0",id:3,method:"tools/call",params:{name:"chaldea_decision_ask",arguments:q}})+"\n");
      try{
        await until("MCP ask",async()=>lines().some(r=>r.id===3));
        assert.equal(lines().find(r=>r.id===2).result.tools.length,12);
        for(const name of ["chaldea_route_review_pair","chaldea_wait_list","chaldea_wait_closeout"])
          assert.ok(lines().find(r=>r.id===2).result.tools.some((tool:{name:string})=>tool.name===name));
        assert.ok(lines().find(r=>r.id===2).result.tools.some((tool:{name:string})=>tool.name==="chaldea_route"));
        const result=lines().find(r=>r.id===3).result;
        assert.equal(result.isError,undefined,err);
        const row=JSON.parse(result.content[0].text);
        for (const [id,args] of [[80,{id:row.id,answer:"Run"}],[81,{id:row.id,answer:"Run",answeringThreadId:parent}]] as const) {
          child.stdin.write(JSON.stringify({jsonrpc:"2.0",id,method:"tools/call",params:{name:"chaldea_decision_answer",arguments:args}})+"\n");
          await until("MCP refused answer "+id,async()=>lines().some(r=>r.id===id));
          assert.equal(lines().find(r=>r.id===id).result.isError,true);
        }
        assert.equal((await invoke("chaldea_decision_status",{id:row.id})).state,"parked");
        const rpc=async(id:number,name:string,args:unknown)=>{
          child.stdin.write(JSON.stringify({jsonrpc:"2.0",id,method:"tools/call",params:{name,arguments:args}})+"\n");
          await until("MCP response "+id,async()=>lines().some(r=>r.id===id));
          const result=lines().find(r=>r.id===id).result;assert.equal(result.isError,undefined);
          return JSON.parse(result.content[0].text);
        };
        const w=await rpc(4,"chaldea_wait",{...waitTime(),description:"Resume contract check",condition:{kind:"time",at:iso(Date.now()+10000)}});
        assert.equal(w.description,"Resume contract check");
        assert.equal(JSON.parse(w.input).description,w.description);
        const status=await rpc(5,"chaldea_wait_status",{id:w.id});
        assert.equal(status.id,w.id);assert.equal(status.description,w.description);
        assert.equal((await rpc(6,"chaldea_wait_cancel",{id:w.id})).delivery,"suppressed");
        const compact=await rpc(90,"chaldea_wait",{...waitTime(),condition:{kind:"time",at:iso(Date.now()+60000)},responseMode:"compact"});
        assert.equal(compact.threadId,parent);assert.equal(compact.lifecycle,"waiting");
        try{
          let selected=await rpc(91,"chaldea_wait_list",{threadId:parent,responseMode:"compact"});
          let found=selected.waits.some((item:{id:string})=>item.id===compact.id);
          // Retained terminal rows and random IDs can place this wait on a later page.
          for(let page=0;!found&&selected.nextCursor&&page<8;page++){
            selected=await rpc(100+page,"chaldea_wait_list",{threadId:parent,cursor:selected.nextCursor,responseMode:"compact"});
            found=selected.waits.some((item:{id:string})=>item.id===compact.id);
          }
          assert.ok(found,"registered wait must appear in the bounded fixture history");
        }finally{
          const closed=await rpc(92,"chaldea_wait_closeout",{threadId:parent,waitIds:[compact.id],responseMode:"compact"});
          assert.equal(closed.results[0].result.cancelOutcome,"suppressed");
          assert.equal(closed.results[0].result.wakeMayStillArrive,false);
        }
        assert.equal((await rpc(7,"chaldea_decision_status",{id:row.id})).id,row.id);
        const answered=await runCli(["decision","answer",row.id,"--answer","Run","--config",configPath],dir.path);
        assert.equal(answered.code,0,answered.stderr);
        assert.equal(JSON.parse(JSON.parse(answered.stdout).outcome).source,"cli");
        await until("MCP-created decision wake",async()=>await wakeCount(row.id)===1);
      }finally{
        child.stdin.end();
        if(child.exitCode===null)await new Promise<void>(r=>child.once("exit",()=>r()));
      }
    });
    await t.test("the same decision API wakes a Codex thread",async()=>{
      const target="codex-decision-"+crypto.randomUUID();const project=(await snapshot()).thread.projectId;
      await withClient({serverUrl:t3.serverUrl,token},c=>c["orchestration.dispatchCommand"]({
        type:"thread.create",commandId:key(),threadId:target,projectId:project,title:"Codex asker",modelSelection:{instanceId:"codex",model:"gpt-6.1-sol"},
        runtimeMode:"full-access",interactionMode:"default",branch:null,worktreePath:null,createdBy:"user",creationSource:"web",
      } as never) as Effect.Effect<unknown,unknown>);
      const row=await invoke("chaldea_decision_ask",{...ask(10000),threadId:target});
      await assert.rejects(invoke("chaldea_decision_answer",{id:row.id,answer:"Run"}),/answeringThreadId/);
      await assert.rejects(invoke("chaldea_decision_answer",{id:row.id,answer:"Run",answeringThreadId:target}),/own decision/);
      await assert.rejects(invoke("chaldea_decision_answer",{id:row.id,answer:"Run",answeringThreadId:"missing-thread"}),/absent/);
      const answered=await invoke("chaldea_decision_answer",{id:row.id,answer:"Run",answeringThreadId:parent});
      assert.equal(JSON.parse(answered.outcome!).source,"mcp:"+parent);
      const targetSnap=()=>withClient({serverUrl:t3.serverUrl,token},c=>c["orchestration.getThreadProjection"]({threadId:target} as never));
      await until("Codex decision wake",async()=>(await targetSnap()).messages.some(m=>m.id==="chaldea-decision:"+row.id+":wake"));
      assert.equal((await targetSnap()).messages.filter(m=>m.id==="chaldea-decision:"+row.id+":wake").length,1);
      assert.ok((await targetSnap()).messages.find(m=>m.id==="chaldea-decision:"+row.id+":wake")!.text.includes('"source":"mcp:'+parent+'"'));
    });
    await t.test("T3 restarts independently while the watcher keeps its durable work",async()=>{
      const row=await invoke("chaldea_wait",{...waitTime(),condition:{kind:"time",at:iso(Date.now()+600)}});
      await watcher?.close();watcher=undefined;
      await t3.stopServer();await sleep(700);await t3.startServer();
      await until("T3-only restart wake",async()=>await wakeCount(row.id)===1,30000);
      assert.equal(await wakeCount(row.id),1);
    });
    await t.test("watcher crash at every durable/send boundary loses no wake and commits no duplicate",async()=>{
      await service!.stop();service=undefined;
      for(const boundary of ["registered","resolved","before_send","after_send","delivered"]){
        childService=await processService(configPath,boundary);
        let row:Item|undefined;
        const input=waitTime();
        // The reply can be lost at any boundary: on a slow host a near-due wait
        // resolves and the service crashes before the reply reaches the caller.
        // The committed intent is read back from the store below either way.
        try{row=await invoke("chaldea_wait",input);}catch{}
        await waitFor("crash at "+boundary,()=>childService!.child.signalCode==="SIGKILL",15_000);
        // Read the exact committed intent after the crash, then reopen through the normal service.
        const db=new WakeStore(config.database,environment);
        row??=db.existing(db.prepare("wait",input));assert.ok(row);const id=row.id;db.close();
        childService=await processService(configPath);
        await until("recovered "+boundary,async()=>await wakeCount(id)===1);
        await sleep(200);assert.equal(await wakeCount(id),1,boundary);
        await childService.stop();childService=undefined;
      }
      service=await startWaitService(config);
    });
    await t.test("watcher and T3 restarts recover overdue waits and questions once",async()=>{
      const time=await invoke("chaldea_wait",{...waitTime(),condition:{kind:"time",at:iso(Date.now()+800)}});
      const q=await invoke("chaldea_decision_ask",ask(800));
      await service!.stop();service=undefined;await watcher?.close();watcher=undefined;
      await t3.stopServer();await sleep(900);await t3.startServer();
      service=await startWaitService(config);
      await until("overdue wait after reboot",async()=>await wakeCount(time.id)===1,30_000);
      await until("overdue question after reboot",async()=>await wakeCount(q.id)===1,30_000);
      await service.stop();service=await startWaitService(config);await sleep(200);
      assert.equal(await wakeCount(time.id),1);assert.equal(await wakeCount(q.id),1);
    });
    const logs=readFileSync(config.logFile,"utf8");
    assert.ok(!logs.includes(token));assert.ok(!logs.includes("Run the dependent"));
  }finally{
    await childService?.stop();await service?.stop();await watcher?.close();
    await t3.stop();dir.remove();
  }
});
