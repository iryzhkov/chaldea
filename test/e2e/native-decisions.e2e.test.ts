import assert from "node:assert/strict";
import { test } from "node:test";
import { join,resolve } from "node:path";
import { mkdirSync,writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { createServer } from "node:http";
import * as Effect from "effect/Effect";
import { startDisposableT3,t3Version } from "../helpers/disposable-t3.ts";
import { scratchDir } from "../helpers/scratch.ts";
import { ShellWatcher,waitFor,dispatchMessage,writePrivateFile,sleep,runCli } from "../helpers/e2e.ts";
import { withClient } from "../../src/t3/adapter.ts";
import { startWaitService,callService } from "../../src/waits/service.ts";
import { WakeStore,type Item } from "../../src/wake/store.ts";
import type { WaitConfig } from "../../src/waits/config.ts";
const skip=t3Version()==="t3 v0.1.0"?false:"Needs pinned disposable T3 0.1.0";
if(skip&&process.env.CHALDEA_REQUIRE_E2E==="1")throw new Error(skip);
const key=()=>Date.now()+":"+crypto.randomUUID();
async function until(what:string,probe:()=>Promise<boolean>,timeout=15_000):Promise<void>{
  const end=Date.now()+timeout;
  while(!await probe()){if(Date.now()>end)throw new Error("Timed out: "+what);await sleep(25);}
}
async function processService(config:string,crash?:string){
  const child=spawn(process.execPath,[resolve("test/helpers/waits-process.ts"),config,...(crash?[crash]:[])],{stdio:["ignore","pipe","pipe"]});
  let out="",err="";child.stdout!.on("data",b=>out+=b);child.stderr!.on("data",b=>err+=b);
  await waitFor("native service ready",()=>{if(child.exitCode!==null)throw new Error(err);return out.includes("ready");},15_000);
  return {child,async stop(){if(child.exitCode!==null||child.signalCode!==null)return;
    const end=new Promise<void>(r=>child.once("exit",()=>r()));child.kill("SIGTERM");await end;}};
}
test("native decisions stay in disposable T3; fallback and deadline policy survive restarts",{skip,timeout:240_000},async t=>{
  const dir=scratchDir("native-decisions");
  const t3=await startDisposableT3({scratchRoot:dir.path,scenario:"no-reset",autoResume:false,codex:"available"});
  let service:Awaited<ReturnType<typeof startWaitService>>|undefined;
  let childService:Awaited<ReturnType<typeof processService>>|undefined;
  let watcher:ShellWatcher|undefined;
  const cards=new Map<string,string>();let loseAck=true;const relayAttempts:string[]=[];
  const relay=createServer(async(req,res)=>{
    assert.equal(req.url,"/notify");assert.equal(req.headers.authorization,"Bearer native-fake-relay");
    let data="";for await(const part of req)data+=part;
    relayAttempts.push(data);const payload=JSON.parse(data);
    if(cards.has(payload.id))assert.equal(cards.get(payload.id),data);
    cards.set(payload.id,data);
    if(loseAck){loseAck=false;res.destroy();return;}res.writeHead(202);res.end("{}");
  });
  await new Promise<void>(r=>relay.listen(0,"127.0.0.1",r));
  try{
    const token=t3.issueToken(["orchestration:read","orchestration:operate"]);
    const rpc=<A>(fn:(c:Parameters<Parameters<typeof withClient>[1]>[0])=>Effect.Effect<A,unknown>)=>withClient({serverUrl:t3.serverUrl,token},fn);
    const environment=await rpc(c=>c["server.getConfig"]({}).pipe(Effect.map(c=>String(c.environment.environmentId))));
    watcher=new ShellWatcher(t3.serverUrl,token);
    const bootstrap=await waitFor("bootstrap",()=>watcher!.firstThreadId(),30_000);
    const projection=(threadId:string)=>rpc(c=>c["orchestration.getThreadProjection"]({threadId} as never));
    const project=(await projection(bootstrap)).thread.projectId;
    const create=async(provider="claudeAgent",approval=false)=>{
      const threadId="native-"+crypto.randomUUID();
      await rpc(c=>c["orchestration.dispatchCommand"]({type:"thread.create",commandId:key(),threadId,projectId:project,title:"Native decisions fixture",
        modelSelection:{instanceId:provider,model:provider==="codex"?"gpt-6.1-sol":"claude-sonnet-4-6"},
        runtimeMode:approval?"approval-required":"full-access",interactionMode:"default",branch:null,worktreePath:null,createdBy:"user",creationSource:"web"} as never));
      return threadId;
    };
    const config:WaitConfig={environment,t3BaseDir:t3.baseDir,tokenFile:join(dir.path,"token"),database:join(dir.path,"state/wakes.sqlite"),
      socket:join(dir.path,"service.sock"),listenAddress:"127.0.0.1",port:0,answerBaseUrl:"http://127.0.0.1:7385",
      threadBaseUrl:"https://t3.fixture.invalid",answerTokenFile:join(dir.path,"answer-token"),notifyUrl:"http://127.0.0.1:"+(relay.address() as {port:number}).port,
      notifyEnvFile:join(dir.path,"notify.env"),logFile:join(dir.path,"state/waits.log")};
    mkdirSync(join(dir.path,"state"));writePrivateFile(config.tokenFile,token);writePrivateFile(config.answerTokenFile,"native-answer-token");
    writePrivateFile(config.notifyEnvFile!,"NOTIFY_TOKEN=native-fake-relay");
    const configPath=join(dir.path,"config.json");writeFileSync(configPath,JSON.stringify(config));
    const invoke=(method:string,input:unknown)=>callService(config.socket,method,input) as Promise<Item>;
    const policy=(threadId:string,ms=1500)=>({threadId,requestId:key(),dependentAction:"deploy the fixture",defaultAction:"defer",deadline:new Date(Date.now()+ms).toISOString()});
    const prepare=(threadId:string,ms?:number)=>invoke("chaldea_decision_prepare",policy(threadId,ms));
    const mcp=async(name:string,args:unknown):Promise<Item>=>{
      const child=spawn(process.execPath,[resolve("src/cli.ts"),"mcp","--config",configPath],{stdio:["pipe","pipe","pipe"]});
      let data="",err="";child.stdout.on("data",b=>data+=b);child.stderr.on("data",b=>err+=b);
      const ended=new Promise<number|null>((resolveEnd,reject)=>{child.once("exit",resolveEnd);child.once("error",reject);});
      child.stdin.end(JSON.stringify({jsonrpc:"2.0",id:1,method:"initialize",params:{}})+"\n"+
        JSON.stringify({jsonrpc:"2.0",id:2,method:"tools/call",params:{name,arguments:args}})+"\n");
      assert.equal(await ended,0,err);
      const result=data.trim().split("\n").map(s=>JSON.parse(s)).find(r=>r.id===2).result;
      assert.equal(result.isError,undefined,JSON.stringify(result));
      return JSON.parse(result.content[0].text);
    };
    const wakeCount=async(thread:string,id:string)=>(await projection(thread)).messages.filter(m=>m.id==="chaldea-decision:"+id+":wake").length;
    const pending=async(thread:string,kind="user_input")=>{
      let id="";
      try{await until("pending "+kind,async()=>{id=(await projection(thread)).runtimeRequests.find(r=>r.status==="pending"&&r.kind===kind)?.id??"";return !!id;});}
      catch(error){const p=await projection(thread);t.diagnostic(JSON.stringify({runs:p.runs.map(r=>r.status),requests:p.runtimeRequests}));throw error;}
      return id;
    };
    const human=async(threadId:string,requestId:string)=>{
      const p=await projection(threadId);const item=p.turnItems.find(i=>i.type==="user_input_request"&&i.requestId===requestId);
      assert.equal(item?.type,"user_input_request");if(item?.type!=="user_input_request")throw new Error("No question");
      await rpc(c=>c["orchestration.dispatchCommand"]({type:"runtime-request.respond",commandId:key(),threadId,requestId,
        answers:Object.fromEntries(item.questions.map(q=>[q.id,"Hold"]))} as never));
    };
    const settled=async(row:Item,timeout=15_000)=>until("native outcome",async()=>(await invoke("chaldea_decision_status",{id:row.id})).outcome!==null,timeout);
    service=await startWaitService(config);
    await t.test("prepare then Claude AskUserQuestion; human answers in T3 with no Chaldea wake",async()=>{
      const thread=await create();const input=policy(thread,15_000);
      const cli=await runCli(["decision","prepare","--thread",thread,"--request-id",input.requestId,"--dependent-action",input.dependentAction,
        "--default-action","defer","--deadline",input.deadline,"--config",configPath],dir.path);
      assert.equal(cli.code,0,cli.stderr);const row=JSON.parse(cli.stdout) as Item;
      await dispatchMessage(t3,token,thread,"chaldea-native-question",key());const requestId=await pending(thread);
      await until("bound question",async()=>service!.store.native(row.id).request_id===requestId);
      const phoneId="chaldea-decision:"+environment+":"+row.id;
      await until("native phone ACK retry",async()=>relayAttempts.filter(s=>JSON.parse(s).id===phoneId).length===2);
      assert.equal(JSON.parse(cards.get(phoneId)!).url,"https://t3.fixture.invalid/"+environment+"/"+thread);
      await human(thread,requestId);await settled(row);
      assert.equal(JSON.parse((await invoke("chaldea_decision_status",{id:row.id})).outcome!).source,"t3");
      assert.equal(await wakeCount(thread,row.id),0);
      await until("Claude continued",async()=>(await projection(thread)).runs.some(r=>r.status==="completed"));
      await service!.stop();service=await startWaitService(config);await sleep(100);
      assert.equal(relayAttempts.filter(s=>JSON.parse(s).id===phoneId).length,2);assert.equal(await wakeCount(thread,row.id),0);
    });
    await t.test("deadline answers every native question with safe text and continues the Claude turn",async()=>{
      const thread=await create();const row=await prepare(thread,2200);
      await dispatchMessage(t3,token,thread,"chaldea-native-question",key());const requestId=await pending(thread);
      await settled(row);const p=await projection(thread),request=p.runtimeRequests.find(r=>r.id===requestId)!;
      assert.equal(request.status,"resolved");assert.equal(Object.keys(request.answers!).length,2);
      assert.ok(Object.values(request.answers!).every(a=>a==="No answer by the deadline: defer deploy the fixture"));
      assert.equal(JSON.parse((await invoke("chaldea_decision_status",{id:row.id})).outcome!).defaulted,true);
      await until("default continued turn",async()=>(await projection(thread)).runs.some(r=>r.status==="completed"));
      assert.equal(await wakeCount(thread,row.id),0);
    });
    await t.test("fixed-only contract state has no safe answer: one attention wake, no approving response",async()=>{
      const thread=await create();
      await dispatchMessage(t3,token,thread,"chaldea-native-question",key());const requestId=await pending(thread);
      // Pinned adapters never emit allowCustomAnswer:false. Seed only the disposable
      // projection to exercise this public contract state through real T3 reads.
      const db=new DatabaseSync(join(t3.baseDir,"userdata/statev2.sqlite"));
      try{
        const rows=db.prepare("SELECT turn_item_id,payload_json FROM orchestration_v2_projection_turn_items WHERE thread_id=? AND type='user_input_request'").all(thread) as Array<{turn_item_id:string;payload_json:string}>;
        assert.equal(rows.length,1);const item=JSON.parse(rows[0]!.payload_json);
        for(const q of item.questions)q.allowCustomAnswer=false;
        db.prepare("UPDATE orchestration_v2_projection_turn_items SET payload_json=? WHERE turn_item_id=?").run(JSON.stringify(item),rows[0]!.turn_item_id);
      }finally{db.close();}
      const p=await projection(thread),q=p.turnItems.find(i=>i.type==="user_input_request");
      assert.equal(q?.type==="user_input_request"&&q.questions[0]!.allowCustomAnswer,false);
      const row=await mcp("chaldea_decision_track",{...policy(thread,1000),runtimeRequestId:requestId});
      await until("attention wake",async()=>await wakeCount(thread,row.id)===1);
      assert.equal((await invoke("chaldea_decision_status",{id:row.id})).state,"needs_attention");
      assert.equal((await projection(thread)).runtimeRequests.find(r=>r.id===requestId)!.status,"pending");
      assert.equal(service!.store.deliveries().filter(d=>d.item===row.id&&d.channel==="native").length,0);
      await human(thread,requestId);await sleep(100);assert.equal(await wakeCount(thread,row.id),1);
    });
    await t.test("native human-versus-deadline commands race in T3 and record exactly one winner",async()=>{
      for(const offset of [-10,10]){
        const thread=await create(),input=policy(thread,1800),row=await mcp("chaldea_decision_prepare",input);
        await dispatchMessage(t3,token,thread,"chaldea-native-question",key());const requestId=await pending(thread);
        await sleep(Math.max(0,Date.parse(input.deadline)+offset-Date.now()));
        const humanWon=await human(thread,requestId).then(()=>true,()=>false);
        await settled(row);const outcome=JSON.parse((await invoke("chaldea_decision_status",{id:row.id})).outcome!);
        assert.equal(outcome.defaulted,!humanWon);
        const request=(await projection(thread)).runtimeRequests.find(r=>r.id===requestId)!;
        assert.equal(request.status,"resolved");
        assert.ok(Object.values(request.answers!).every(a=>a===(humanWon?"Hold":"No answer by the deadline: defer deploy the fixture")));
        assert.equal(await wakeCount(thread,row.id),0);
      }
    });
    await t.test("permissions cannot bind a preparation and explicit tracking is refused",async()=>{
      const thread=await create("claudeAgent",true),row=await prepare(thread,1000);
      await dispatchMessage(t3,token,thread,"chaldea-native-permission",key());
      let requestId="";
      await until("permission pending",async()=>{requestId=(await projection(thread)).runtimeRequests.find(r=>r.status==="pending"&&r.kind!=="user_input")?.id??"";return !!requestId;});
      await assert.rejects(invoke("chaldea_decision_track",{...policy(thread),runtimeRequestId:requestId}),/permissions and approvals/);
      await settled(row);assert.equal(JSON.parse((await invoke("chaldea_decision_status",{id:row.id})).outcome!).reason,"preparation_expired");
      assert.equal((await projection(thread)).runtimeRequests.find(r=>r.id===requestId)!.status,"pending");
      assert.equal(await wakeCount(thread,row.id),0);
      await rpc(c=>c["orchestration.dispatchCommand"]({type:"runtime-request.respond",commandId:key(),threadId:thread,requestId,decision:"decline"} as never));
    });
    await t.test("watcher crash at every native durable/send boundary replays one response without a wake",async()=>{
      await service!.stop();service=undefined;
      for(const boundary of ["registered","native_bound","native_queued","before_send","after_send","delivered","resolved"]){
        const thread=await create(),input=policy(thread,1600);let row:Item|undefined;
        childService=await processService(configPath,boundary);
        try{row=await invoke("chaldea_decision_prepare",input);}catch{assert.equal(boundary,"registered");}
        await dispatchMessage(t3,token,thread,"chaldea-native-question",key());
        await waitFor("native crash "+boundary,()=>childService!.child.signalCode==="SIGKILL",15_000);
        const db=new WakeStore(config.database,environment);row??=db.existing(db.prepare("native",input));assert.ok(row);db.close();
        childService=await processService(configPath);await settled(row);
        const result=JSON.parse((await invoke("chaldea_decision_status",{id:row.id})).outcome!);assert.equal(result.defaulted,true,boundary);
        const p=await projection(thread),request=p.runtimeRequests.find(r=>r.kind==="user_input")!;
        assert.equal(request.status,"resolved");assert.ok(Object.values(request.answers!).every(a=>a==="No answer by the deadline: defer deploy the fixture"));
        assert.equal(await wakeCount(thread,row.id),0);
        await childService.stop();childService=undefined;
      }
      service=await startWaitService(config);
    });
    await t.test("known Codex async request survives watcher and T3 restart; native answer continues exactly once",async()=>{
      const thread=await create("codex");await dispatchMessage(t3,token,thread,"chaldea-native-async",key());const requestId=await pending(thread);
      const input=policy(thread,1500);
      const tracked=await runCli(["decision","track","--thread",thread,"--runtime-request",requestId,"--request-id",input.requestId,
        "--dependent-action",input.dependentAction,"--default-action","defer","--deadline",input.deadline,"--config",configPath],dir.path);
      assert.equal(tracked.code,0,tracked.stderr);const row=JSON.parse(tracked.stdout) as Item;
      await service!.stop();service=undefined;await watcher?.close();watcher=undefined;
      await t3.stopServer();await sleep(1600);await t3.startServer();service=await startWaitService(config);
      await settled(row);assert.equal(JSON.parse((await invoke("chaldea_decision_status",{id:row.id})).outcome!).defaulted,true);
      const p=await projection(thread);
      assert.equal(p.messages.filter(m=>m.id==="async-answer:"+requestId).length,1);assert.equal(await wakeCount(thread,row.id),0);
      await service.stop();service=await startWaitService(config);await sleep(100);
      assert.equal((await projection(thread)).messages.filter(m=>m.id==="async-answer:"+requestId).length,1);
    });
    await t.test("native prepare, old-question track and human answers survive paging beyond 77 rows and restart",async()=>{
      const thread=await create("codex"),row=await prepare(thread,20_000);
      const ids:string[]=[],items:string[]=[];
      for(let n=0;n<3;n++){
        await dispatchMessage(t3,token,thread,"chaldea-native-async",key());
        await until("async question "+n,async()=>{
          const p=await projection(thread),r=p.runtimeRequests.find(r=>r.status==="pending"&&r.kind==="user_input"&&!ids.includes(r.id));
          if(!r)return false;
          const item=p.turnItems.find(i=>i.type==="user_input_request"&&i.requestId===r.id);
          if(!item)return false;ids.push(r.id);items.push(item.id);return true;
        });
      }
      await until("schema captured",async()=>!!service!.store.native(row.id).questions);
      // More than ten subsequent user turns and 90 activity items move every
      // original question outside pinned T3's bounded projection window.
      for(let n=0;n<12;n++){
        const messageKey=key();await dispatchMessage(t3,token,thread,n===11?"chaldea-native-burst":"continue unrelated fixture work",messageKey);
        await until("background turn "+n,async()=>(await projection(thread)).runs.some(r=>r.userMessageId==="e2e-message-"+messageKey&&r.status==="completed"));
      }
      const bounded=await projection(thread);
      assert.ok(ids.every(id=>bounded.runtimeRequests.some(r=>r.id===id&&r.status==="pending")));
      assert.ok(!bounded.turnItems.some(i=>i.type==="user_input_request"&&ids.includes(i.requestId)),"questions actually left the history window");
      const old=await invoke("chaldea_decision_track",{...policy(thread,15_000),runtimeRequestId:ids[1]});
      const answered=await invoke("chaldea_decision_track",{...policy(thread,30_000),runtimeRequestId:ids[2]});
      await service!.stop();service=await startWaitService(config);
      await rpc(c=>c["orchestration.dispatchCommand"]({type:"runtime-request.respond",commandId:key(),threadId:thread,requestId:ids[2],answers:{"0":"Hold"}} as never));
      await settled(answered);
      assert.equal(JSON.parse((await invoke("chaldea_decision_status",{id:answered.id})).outcome!).source,"t3");
      assert.equal(await wakeCount(thread,answered.id),0);
      for(const [policyRow,index] of [[row,0],[old,1]] as const){
        await settled(policyRow,30_000);
        const result=await rpc(c=>c["orchestration.getTurnItem"]({threadId:thread,itemId:items[index]} as never));
        assert.equal(result.item?.type,"user_input_request");
        if(result.item?.type!=="user_input_request")throw new Error("Historical question missing");
        assert.equal(result.item.status,"completed");
        assert.deepEqual(result.item.questionAnswer?.answers,{"0":"No answer by the deadline: defer deploy the fixture"});
        assert.equal(JSON.parse((await invoke("chaldea_decision_status",{id:policyRow.id})).outcome!).defaulted,true);
        assert.equal(await wakeCount(thread,policyRow.id),0);
      }
      const p=await projection(thread);
      for(const id of ids)assert.equal(p.messages.filter(m=>m.id==="async-answer:"+id).length,1);
    });
    await t.test("a lost live Claude request is reported honestly after T3 restart",async()=>{
      const thread=await create(),row=await prepare(thread,10_000);
      await dispatchMessage(t3,token,thread,"chaldea-native-question",key());await pending(thread);
      await until("live binding",async()=>!!service!.store.native(row.id).request_id);
      await service!.stop();service=undefined;await t3.stopServer();await t3.startServer();service=await startWaitService(config);
      await until("lost live attention",async()=>await wakeCount(thread,row.id)===1,30_000);
      assert.equal((await invoke("chaldea_decision_status",{id:row.id})).state,"needs_attention");
    });
  }finally{
    await childService?.stop();await service?.stop();await watcher?.close();await t3.stop();
    await new Promise<void>(r=>relay.close(()=>r()));dir.remove();
  }
});
