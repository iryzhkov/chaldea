import assert from "node:assert/strict";
import test from "node:test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync,mkdtempSync,writeFileSync,rmSync,chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { connect,nkeys,nkeyAuthenticator,type NatsConnection } from "@nats-io/transport-node";
import { jetstreamManager,AckPolicy,StorageType,RetentionPolicy,DiscardPolicy } from "@nats-io/jetstream";
import { message,senderConfig,senderConfigPath,senderBinding,request,identity,requestHash,messageTargets,type SenderConfig } from "../../src/message.ts";
import { receiverConfig,receiverBinding,runReceiver,deliver,receive,type ReceiverConfig } from "../../src/message-receiver.ts";
import { connection,publish,pull,acknowledge,next,decodeReceipt,brokerConfig,type Mapping } from "../../src/message-broker.ts";
import { MessageStore,WINDOW } from "../../src/message-store.ts";
import { startDisposableT3,t3Version } from "../helpers/disposable-t3.ts";
import { ShellWatcher,waitFor,dispatchMessage } from "../helpers/e2e.ts";
import { withClient,dispatchChaldeaWake } from "../../src/t3/adapter.ts";
const delay=(ms:number)=>new Promise(r=>setTimeout(r,ms));
test("production messaging: pinned broker/T3 identity, recovery, concurrency and lifecycle",{timeout:240000},async t=>{
 assert.notEqual(homedir(),"/home/igor");assert.notEqual(homedir(),"/root");
 assert.ok(process.env.NATS_SERVER);assert.equal(t3Version(),"t3 v0.1.0");
 const root=mkdtempSync(join(homedir(),"message-nats-"));
 const keys={a:nkeys.createUser(),b:nkeys.createUser(),receiver:nkeys.createUser(),attacker:nkeys.createUser()};
 const listener=createServer();listener.listen(0,"127.0.0.1");await once(listener,"listening");
 const port=(listener.address() as {port:number}).port;await new Promise<void>(r=>listener.close(()=>r()));
 const url="nats://127.0.0.1:"+port+"/",file=join(root,"nats.conf");
 const route=(id:string):Mapping=>({commandSubject:"chaldea.message.command."+id+".source.target",
  receiptSubject:"chaldea.message.receipt."+id+".source.target",commandConsumer:"receive_"+id,receiptConsumer:"source_"+id});
 const routes={a:route("a"),b:route("b")};
 const connectionConfig=(id:keyof typeof keys)=>({url,account:"MESSAGES",seedFile:join(root,id+".seed"),publicKey:keys[id].getPublicKey(),
  inboxPrefix:"_INBOX_message."+id,commandStream:"MESSAGE_COMMANDS",receiptStream:"MESSAGE_RECEIPTS"});
 for(const [id,key]of Object.entries(keys))writeFileSync(join(root,id+".seed"),key.getSeed(),{mode:0o600});
 const grants=(h:Mapping,receiver=false)=>[receiver?h.receiptSubject:h.commandSubject,
  next(receiver?"MESSAGE_COMMANDS":"MESSAGE_RECEIPTS",receiver?h.commandConsumer:h.receiptConsumer),
  "$JS.ACK."+(receiver?"MESSAGE_COMMANDS."+h.commandConsumer:"MESSAGE_RECEIPTS."+h.receiptConsumer)+".>"];
 writeFileSync(file,`host:"127.0.0.1"
port:${port}
max_payload:32768
jetstream {store_dir:"${join(root,"broker")}",max_file_store:16777216,max_memory_store:1048576}
accounts {MESSAGES {jetstream:enabled, users:[
 {user:"fixture-admin",password:"disposable-only"}
 ${(["a","b"] as const).map(id=>`{nkey:"${keys[id].getPublicKey()}",permissions:{publish:${JSON.stringify(grants(routes[id]))},subscribe:["_INBOX_message.${id}.>"]}}`).join("\n")}
 {nkey:"${keys.receiver.getPublicKey()}",permissions:{publish:${JSON.stringify([...grants(routes.a,true),...grants(routes.b,true)])},subscribe:["_INBOX_message.receiver.>"]}}
 {nkey:"${keys.attacker.getPublicKey()}",permissions:{publish:${JSON.stringify([...grants(routes.b),...grants(routes.b,true)])},subscribe:["_INBOX_message.attacker.>"]}}
]}}
`,{mode:0o600});
 let server:ChildProcess|undefined;const connections:NatsConnection[]=[];
 async function admin(){const nc=await connect({servers:url,user:"fixture-admin",pass:"disposable-only",reconnect:false,timeout:100});connections.push(nc);return nc;}
 async function start(){
  server=spawn(process.env.NATS_SERVER!,["-c",file],{stdio:"ignore"});
  for(let i=0;i<100;i++){try{return await admin();}catch{assert.equal(server.exitCode,null,"NATS fixture exited");await delay(30);}}
  throw new Error("NATS fixture startup timeout");
 }
 async function stop(){if(server&&server.exitCode===null){const done=once(server,"close");server.kill("SIGTERM");await done;}}
 let a=await start();
 const manager=await jetstreamManager(a);
 for(const [name,subjects,age]of [["MESSAGE_COMMANDS",Object.values(routes).map(r=>r.commandSubject),24*3600e9],
  ["MESSAGE_RECEIPTS",Object.values(routes).map(r=>r.receiptSubject),120e9]] as const){
  await manager.streams.add({name,subjects:[...subjects],storage:StorageType.File,retention:RetentionPolicy.Workqueue,discard:DiscardPolicy.New,
   max_age:age,max_bytes:1048576,max_msgs:256,max_msgs_per_subject:32,discard_new_per_subject:true,max_msg_size:8192,num_replicas:1,max_consumers:8,duplicate_window:60e9});
  for(const r of Object.values(routes))await manager.consumers.add(name,{durable_name:name==="MESSAGE_COMMANDS"?r.commandConsumer:r.receiptConsumer,
   filter_subject:name==="MESSAGE_COMMANDS"?r.commandSubject:r.receiptSubject,ack_policy:AckPolicy.Explicit,ack_wait:250e6,
   max_deliver:5,max_ack_pending:32,max_batch:1,max_waiting:32,max_expires:1e9});
 }
 const t3=await startDisposableT3({scratchRoot:root,scenario:"no-reset",autoResume:false});
 const token=t3.issueToken(["orchestration:read","orchestration:operate"]);writeFileSync(join(root,"t3-token"),token,{mode:0o600});
 let watcher:ShellWatcher|undefined=new ShellWatcher(t3.serverUrl,token);
 const threadId=await waitFor("bootstrap thread",()=>watcher!.firstThreadId(),30000);
 function stmtSafe(db:MessageStore,n:number){db.db.prepare("INSERT INTO attempts VALUES(?,?,?,?,NULL,?)").run(randomUUID(),"held-"+n,"held",Date.now()+WINDOW,"fixture");}
 const opts=()=>({serverUrl:t3.serverUrl,token});
 const env=String((await withClient(opts(),c=>c["server.getConfig"]({}))).environment.environmentId);
 const projection=()=>withClient(opts(),c=>c["orchestration.getThreadProjection"]({threadId} as never));
 let c:ReceiverConfig,s:SenderConfig,receiverFile:string,sourceFile:string;
 let service:Promise<void>|undefined,controller:AbortController|undefined;
 const input=(key:string)=>({host:"target",threadId,requestId:Date.now()+":"+key,text:"synthetic queued NATS qualification"});
 const wire=(i:ReturnType<typeof input>)=>request({v:1,op:"send",host:"target",environment:env,threadId,requestId:i.requestId,text:i.text});
 const ids=(r:ReturnType<typeof request>,caller="a")=>identity(caller,"source-"+caller,r);
 const count=async(r:ReturnType<typeof request>,caller="a")=>(await projection()).messages.filter(m=>m.id===ids(r,caller).messageId).length;
 async function stopService(){controller?.abort();await service;service=undefined;controller=undefined;}
 function startService(){controller=new AbortController();service=runReceiver(receiverFile,controller.signal);return service;}
 async function reset(label:string){
  await stopService();const m=await jetstreamManager(a);await m.streams.purge("MESSAGE_COMMANDS");await m.streams.purge("MESSAGE_RECEIPTS");
  const dir=join(root,label);mkdirSync(dir,{mode:0o700});receiverFile=join(dir,"receiver.json");sourceFile=join(dir,"source.json");
  c={host:"target",environment:env,loopbackT3Url:t3.serverUrl,tokenFile:join(root,"t3-token"),database:join(dir,"receiver.db"),
   logFile:join(dir,"events.jsonl"),broker:connectionConfig("receiver"),callers:{
    a:{...routes.a,sourceHost:"source-a",publisherKey:keys.a.getPublicKey(),threads:[threadId]},
    b:{...routes.b,sourceHost:"source-b",publisherKey:keys.b.getPublicKey(),threads:[threadId]}}};
  s={callerId:"a",sourceHost:"source-a",database:join(dir,"source.db"),broker:connectionConfig("a"),
   hosts:{target:{...routes.a,destinationHost:"target",environment:env,threads:[threadId]}}};
  writeFileSync(receiverFile,JSON.stringify(c),{mode:0o600});writeFileSync(sourceFile,JSON.stringify(s),{mode:0o600});
  new MessageStore(c.database,receiverBinding(c),true).close();new MessageStore(s.database,senderBinding(s),true).close();
  assert.deepEqual(JSON.parse(JSON.stringify(receiverConfig(receiverFile))),c);assert.deepEqual(JSON.parse(JSON.stringify(senderConfig(sourceFile))),s);
 }
 async function sourceConnection(){const nc=await connection(s.broker);connections.push(nc);return nc;}
 async function receiverConnection(){const nc=await connection(c.broker);connections.push(nc);return nc;}
 async function brokerDeny(subject:string,subscribe=false){
  const nc=await connection(connectionConfig("attacker"));connections.push(nc);let denied=false;
  const watch=(async()=>{for await(const status of nc.status())if(status.type==="error")denied=true;})();
  if(subscribe)nc.subscribe(subject);else nc.publish(subject,"{}");
  await nc.flush();await delay(60);await nc.close();await watch;assert.equal(denied,true);
 }
 try{
  await t.test("private root config, exact mappings, identity pin and configured targets",async()=>{
   await reset("config");assert.deepEqual(messageTargets(s),[{host:"target",threads:[threadId]}]);
   const oldXdg=process.env.XDG_CONFIG_HOME;process.env.XDG_CONFIG_HOME=join(root,"xdg");
   try{assert.equal(senderConfigPath(),join(root,"xdg/chaldea/message.json"));}finally{if(oldXdg===undefined)delete process.env.XDG_CONFIG_HOME;else process.env.XDG_CONFIG_HOME=oldXdg;}
   const limits=(await(await jetstreamManager(a)).streams.info("MESSAGE_RECEIPTS")).config;
   assert.equal(limits.max_age,120e9);assert.equal(limits.max_msgs_per_subject,32);assert.equal(limits.discard_new_per_subject,true);
   chmodSync(sourceFile,0o644);assert.throws(()=>senderConfig(sourceFile));chmodSync(sourceFile,0o640);assert.deepEqual(JSON.parse(JSON.stringify(senderConfig(sourceFile))),s);
   for(const broker of [{...s.broker,account:"CHALDEA"},{...s.broker,url:"nats://192.0.2.1:4222/"},
    {...s.broker,url:"wss://user:password@example.invalid/"},{...s.broker,inboxPrefix:"_INBOX_message.>"}])assert.throws(()=>brokerConfig(broker));
   await assert.rejects(connection({...s.broker,publicKey:keys.b.getPublicKey()}),/message_broker_unavailable/);
   await assert.rejects(connection({...s.broker,url:url.replace("nats:","tls:")}),/message_broker_unavailable/);
   const bad={...c,callers:{...c.callers,b:{...c.callers.b!,commandSubject:c.callers.a!.commandSubject}}};
   writeFileSync(receiverFile,JSON.stringify(bad));assert.throws(()=>receiverConfig(receiverFile));writeFileSync(receiverFile,JSON.stringify(c));
  });
  await t.test("pull timeout includes bounded network delay beyond the old half-second margin",async()=>{
   await reset("pull-margin");const nc=await receiverConnection(),original=nc.publish.bind(nc);
   nc.publish=((subject:string,...args:unknown[])=>{if(subject===next("MESSAGE_COMMANDS",routes.a.commandConsumer))setTimeout(()=>{(original as (...args:unknown[])=>void)(subject,...args);},2000);else(original as (...args:unknown[])=>void)(subject,...args);}) as typeof nc.publish;
   const start=Date.now();assert.equal(await pull(nc,c.broker,routes.a,AbortSignal.timeout(5000)),undefined);assert.ok(Date.now()-start>=2800);nc.publish=original;
  });
  await t.test("production service, one T3 effect, identical retry/status, queued active work/provider",async()=>{
   await reset("once");void startService();const i=input("once"),r=wire(i),before=await projection();
   await dispatchMessage(t3,token,threadId,"active chaldea-waits-delay:5000","nats-active");
   const deadline=Date.now()+10000;while(!(await projection()).runs.some(r=>r.status==="running")){assert.ok(Date.now()<deadline);await delay(30);}
   const active=(await projection()).runs.find(r=>r.status==="running")!,start=performance.now();
   const first=await message("send",i,s);assert.equal(first.state,"accepted");assert.equal(await count(r),1);
   t.diagnostic("single send-to-T3-receipt loopback ms="+(performance.now()-start).toFixed(1));
   const after=await projection();assert.deepEqual(after.thread.modelSelection,before.thread.modelSelection);
   assert.equal(after.runs.find(r=>r.id===active.id)?.status,"running");
   assert.equal(after.runs.find(run=>run.userMessageId===ids(r).messageId)?.status,"queued");
   assert.deepEqual(await message("send",i,s),first);
   assert.deepEqual(await message("status",{host:i.host,threadId,requestId:i.requestId},s),first);
   assert.deepEqual(await message("recover",{host:i.host,threadId,requestId:i.requestId},s),first);
   await stopService();void startService();assert.deepEqual(await message("send",i,s),first);assert.equal(await count(r),1);
  });
  await t.test("concurrent sender requests consume reversed receipts without stealing outcomes",async()=>{
   await reset("concurrent");const i=input("one"),j=input("two"),r=wire(i),q=wire(j);
   const one=message("send",i,s),two=message("send",j,s),nc=await receiverConnection(),db=new MessageStore(c.database,receiverBinding(c));
   try{
    const items=[];for(let n=0;n<2;n++){const m=await pull(nc,c.broker,routes.a,AbortSignal.timeout(5000));assert.ok(m);items.push(m);}
    const results=[];for(const m of items){const body=request(JSON.parse(new TextDecoder().decode(m.data)));
     results.push(await receive(body,{caller:"a",sourceHost:"source-a",subject:m.subject},c,db,()=>receiverConfig(receiverFile)));}
    for(let n=1;n>=0;n--){await publish(nc,c.broker,routes.a,Buffer.from(JSON.stringify(results[n])),items[n]!.headers!.get("Chaldea-Attempt"),true);acknowledge(nc,c.broker,routes.a,items[n]!);}
    const [x,y]=await Promise.all([one,two]);assert.equal(x.state,"accepted");assert.equal(y.state,"accepted");
    assert.equal(x.commandId,ids(r).commandId);assert.equal(y.commandId,ids(q).commandId);assert.equal(await count(r),1);assert.equal(await count(q),1);
   }finally{db.close();}
  });
  await t.test("CLI processes sharing a sender journal serialize intent and correlated receipts",async()=>{
   await reset("processes");void startService();const i=input("process-one"),j=input("process-two");
   const held=new MessageStore(s.database,senderBinding(s));
   const launch=(v:ReturnType<typeof input>)=>{
    const child=spawn(process.execPath,["src/cli.ts","message","send","--config",sourceFile,"--host","target","--thread",threadId,"--request-id",v.requestId,"--text",v.text],{stdio:["ignore","pipe","pipe"]});
    let output="",error="";child.stdout!.on("data",b=>{output+=b;assert.ok(output.length<4096);});child.stderr!.on("data",b=>{error+=b;assert.ok(error.length<4096);});
    return new Promise<ReturnType<typeof decodeReceipt>>((resolve,reject)=>child.once("close",code=>{
     try{assert.equal(code,0,error);resolve(decodeReceipt(Buffer.from(output.trim())));}catch(e){reject(e);}
    }));
   };
   const one=launch(i),two=launch(j);await delay(1000);held.close();
   const [x,y]=await Promise.all([one,two]);assert.equal(x.state,"accepted");assert.equal(y.state,"accepted");
   assert.equal(x.commandId,ids(wire(i)).commandId);assert.equal(y.commandId,ids(wire(j)).commandId);assert.equal(await count(wire(i)),1);assert.equal(await count(wire(j)),1);
  });
  await t.test("identity-poison receipt is terminated without failing the matching live exchange",async()=>{
   await reset("receipt-poison");const i=input("receipt-poison"),r=wire(i),pending=message("send",i,s),nc=await receiverConnection();
   const m=await pull(nc,c.broker,routes.a,AbortSignal.timeout(5000));assert.ok(m);const nonce=m.headers!.get("Chaldea-Attempt");
   await publish(nc,c.broker,routes.a,Buffer.from(JSON.stringify({state:"accepted",commandId:"wrong",messageId:"wrong"})),nonce,true);await delay(100);
   const db=new MessageStore(c.database,receiverBinding(c));
   try{const result=await receive(r,{caller:"a",sourceHost:"source-a",subject:m.subject},c,db,()=>receiverConfig(receiverFile));
    await publish(nc,c.broker,routes.a,Buffer.from(JSON.stringify(result)),nonce,true);acknowledge(nc,c.broker,routes.a,m);
   }finally{db.close();}
   assert.equal((await pending).state,"accepted");assert.equal(await count(r),1);
  });
  await t.test("caller capacity/status pressure and receipt publication failure leave the other caller running",async()=>{
   await reset("capacity");const db=new MessageStore(c.database,receiverBinding(c)),stmt=db.db.prepare("INSERT INTO attempts VALUES(?,?,?,?,NULL,?)");
   db.db.exec("BEGIN");for(let n=0;n<1000;n++)stmt.run(randomUUID(),"held-"+n,"held",Date.now()+WINDOW,"a");db.db.exec("COMMIT");
   assert.throws(()=>db.reserve(randomUUID(),"full","full",Date.now()+WINDOW,Date.now(),true,"a"),/message_caller_attempt_capacity/);db.close();
   const b:SenderConfig={...s,callerId:"b",sourceHost:"source-b",database:join(root,"capacity-b.db"),broker:connectionConfig("b"),hosts:{target:{...s.hosts.target!,...routes.b}}};
   new MessageStore(b.database,senderBinding(b),true).close();void startService();const i=input("full-a"),r=wire(i);
   assert.equal((await message("send",i,s)).state,"uncertain");assert.equal(await count(r),0);
   const j=input("capacity-b");assert.equal((await message("send",j,b)).state,"accepted");assert.equal(await count(wire(j),"b"),1);
   const states=[];for(let n=0;n<12;n++)states.push((await message("status",{host:"target",threadId,requestId:j.requestId},b)).state);
   assert.ok(states.every(state=>state==="accepted"||state==="uncertain"));await stopService();
   const check=new MessageStore(c.database,receiverBinding(c));assert.equal(check.db.prepare("SELECT count(*) AS n FROM attempts").get()!.n,1001);check.close();
   // Shared global-cap refusal is also before dispatch; no second reservation/worker failure.
   const full=new MessageStore(c.database,receiverBinding(c));full.db.exec("BEGIN");for(let n=1001;n<10000;n++)stmtSafe(full,n);full.db.exec("COMMIT");assert.throws(()=>full.reserve(randomUUID(),"full","full",Date.now()+WINDOW,Date.now(),true,"b"),/message_attempt_capacity/);full.close();
   void startService();const k=input("global-full");assert.equal((await message("send",k,b)).state,"uncertain");assert.equal(await count(wire(k),"b"),0);await stopService();
   await reset("publication-isolation");const nc=await receiverConnection();
   for(let n=0;n<32;n++)await publish(nc,c.broker,routes.a,Buffer.from(JSON.stringify({state:"uncertain",commandId:"stale",messageId:"stale"})),randomUUID(),true);
   await assert.rejects(publish(nc,c.broker,routes.a,Buffer.from("{}"),randomUUID(),true));
   const source=await sourceConnection(),aInput=input("blocked-receipt"),aRequest=wire(aInput);await publish(source,s.broker,routes.a,Buffer.from(JSON.stringify(aRequest)),randomUUID());
   void startService();const deadline=Date.now()+5000;while(await count(aRequest)!==1){assert.ok(Date.now()<deadline);await delay(30);}
   const other={...b,database:join(root,"isolation-b.db")};new MessageStore(other.database,senderBinding(other),true).close();
   const q=input("isolated-b");assert.equal((await message("send",q,other)).state,"accepted");assert.equal(await count(wire(q),"b"),1);
  });
  await t.test("T3 commit/receipt-state failure parks interrupted attempt; explicit original-ID retry survives T3 restart",async()=>{
   await reset("crash");const i=input("crash"),r=wire(i),pending=message("send",i,s),nc=await receiverConnection();
   let db=new MessageStore(c.database,receiverBinding(c));
   db.finish=()=>{throw new Error("injected receipt commit loss");};db.answer=()=>{throw new Error("injected attempt commit loss");};
   await assert.rejects(deliver(nc,c,"a",db,()=>receiverConfig(receiverFile),AbortSignal.timeout(10000)));
   assert.equal(await count(r),1);assert.ok(db.get(ids(r).commandId)?.payload);db.close();
   await watcher!.close();watcher=undefined;await t3.stopServer();await t3.startServer();c={...c,loopbackT3Url:t3.serverUrl};
   writeFileSync(receiverFile,JSON.stringify(c));db=new MessageStore(c.database,receiverBinding(c));await delay(300);
   try{await deliver(nc,c,"a",db,()=>receiverConfig(receiverFile),AbortSignal.timeout(5000));}
   finally{db.close();}
   assert.equal((await pending).state,"uncertain");assert.equal(await count(r),1);
   void startService();assert.equal((await message("send",i,s)).state,"accepted");assert.equal(await count(r),1);
  });
  await t.test("receipt publication loss redelivers durable acceptance without dispatching again",async()=>{
   await reset("receipt");const i=input("receipt"),r=wire(i),pending=message("send",i,s),nc=await receiverConnection();
   const original=nc.request.bind(nc);nc.request=((subject:string,...args:unknown[])=>{
    if(subject===routes.a.receiptSubject)return Promise.reject(new Error("injected publication loss"));
    return (original as (...args:unknown[])=>unknown)(subject,...args);
   }) as typeof nc.request;
   const db=new MessageStore(c.database,receiverBinding(c));
   try{await assert.rejects(deliver(nc,c,"a",db,()=>receiverConfig(receiverFile),AbortSignal.timeout(10000)));
    assert.equal(db.get(ids(r).commandId)?.state,"accepted");assert.equal(await count(r),1);
    nc.request=original;await delay(300);
    await deliver(nc,c,"a",db,()=>receiverConfig(receiverFile),AbortSignal.timeout(5000));
    assert.equal((await pending).state,"accepted");assert.equal(await count(r),1);
   }finally{db.close();}
  });
  await t.test("malformed poison does not starve valid work; expiry, wrong thread and live ACL revoke fail closed",async()=>{
   await reset("poison");const nc=await sourceConnection();
   for(let n=0;n<32;n++)await publish(nc,c.broker,routes.a,Buffer.from("{"),randomUUID());
   await assert.rejects(publish(nc,c.broker,routes.a,Buffer.from("{"),randomUUID()));
   void startService();
   const deadline=Date.now()+10000;
   while((await(await jetstreamManager(a)).streams.info("MESSAGE_COMMANDS")).state.messages>0){assert.ok(Date.now()<deadline);await delay(30);}
   const r={...wire(input("expired")),requestId:(Date.now()-WINDOW-1000)+":expired"};
   await publish(nc,c.broker,routes.a,Buffer.from(JSON.stringify(r)),randomUUID());
   const i=input("valid");assert.equal((await message("send",i,s)).state,"accepted");assert.equal(await count(wire(i)),1);
   const wrong={...wire(input("unlisted")),threadId:"unlisted"};
   await publish(nc,c.broker,routes.a,Buffer.from(JSON.stringify(wrong)),randomUUID());
   c={...c,callers:{...c.callers,a:{...c.callers.a!,threads:[]}}};writeFileSync(receiverFile,JSON.stringify(c));
   assert.equal((await message("send",input("revoked"),s)).state,"uncertain");
   assert.equal(await count(r),0);
  });
  await t.test("broker subjects, other consumer/ACK/inbox and admin APIs deny B",async()=>{
   for(const subject of [routes.a.commandSubject,routes.a.receiptSubject,
    next("MESSAGE_COMMANDS",routes.a.commandConsumer),next("MESSAGE_RECEIPTS",routes.a.receiptConsumer),
    "$JS.ACK.MESSAGE_COMMANDS."+routes.a.commandConsumer+".1.1.1.1.0","$JS.API.INFO",
    "$JS.API.STREAM.CREATE.EVIL","$JS.API.STREAM.MSG.GET.MESSAGE_COMMANDS","$JS.API.CONSUMER.CREATE.MESSAGE_COMMANDS.evil","$SYS.REQ.SERVER.PING"])await brokerDeny(subject);
   await brokerDeny("_INBOX_message.a.>",true);await brokerDeny("chaldea.message.>",true);
  });
  await t.test("allowed B pull replies preserve B subject, cannot become caller A, forge receipts or administer",async()=>{
   await reset("bridge");const nc=await connection(connectionConfig("attacker"));connections.push(nc);
   const ra=await receiverConnection(),r=wire(input("bridge"));
   await publish(nc,c.broker,routes.b,Buffer.from(JSON.stringify(r)),randomUUID());
   nc.publish(next("MESSAGE_COMMANDS",routes.b.commandConsumer),JSON.stringify({batch:1,no_wait:true}),{reply:routes.a.commandSubject});
   await nc.flush();await delay(100);
   const info=await(await jetstreamManager(a)).streams.info("MESSAGE_COMMANDS"),last=await(await jetstreamManager(a)).streams.getMessage("MESSAGE_COMMANDS",{seq:info.state.last_seq});
   assert.ok(last);assert.equal(last.subject,routes.b.commandSubject);
   assert.equal(await pull(ra,c.broker,routes.a,AbortSignal.timeout(3000)),undefined);assert.equal(await count(r),0);
   const m=await jetstreamManager(a);await m.streams.purge("MESSAGE_COMMANDS");
   const forged={...ids(r),state:"accepted"};await publish(nc,c.broker,routes.b,Buffer.from(JSON.stringify(forged)),randomUUID());
   nc.publish(next("MESSAGE_COMMANDS",routes.b.commandConsumer),JSON.stringify({batch:1,no_wait:true}),{reply:routes.a.receiptSubject});
   await nc.flush();await delay(100);
   const source=await sourceConnection();assert.equal(await pull(source,s.broker,routes.a,AbortSignal.timeout(3000),true),undefined);
   await m.streams.purge("MESSAGE_COMMANDS");
   const bad={name:"EVIL",subjects:["evil"],storage:"file",max_bytes:8192,max_msgs:1,max_consumers:1,max_age:1e9};
   await publish(nc,c.broker,routes.b,Buffer.from(JSON.stringify(bad)),randomUUID());
   nc.publish(next("MESSAGE_COMMANDS",routes.b.commandConsumer),JSON.stringify({batch:1,no_wait:true}),{reply:"$JS.API.STREAM.CREATE.EVIL"});
   await nc.flush();await delay(100);await assert.rejects(m.streams.info("EVIL"));
  });
  await t.test("broker outage retains local intent, same-host T3 works, service reconnects and stop is bounded",async()=>{
   await reset("outage");void startService();await stop();const i=input("offline"),r=wire(i);
   assert.equal((await message("send",i,s)).state,"uncertain");
   const db=new MessageStore(s.database,senderBinding(s));assert.equal(db.get(ids(r).commandId)?.payload,JSON.stringify(r));db.close();
   await dispatchChaldeaWake(opts(),JSON.stringify({type:"message.dispatch",commandId:"local-outage-command",messageId:"local-outage-message",
    threadId,text:"synthetic local work",createdBy:"agent",creationSource:"server",attachments:[],dispatchMode:{type:"queue_after_active"}}));
   assert.equal((await projection()).messages.filter(m=>m.id==="local-outage-message").length,1);
   a=await start();assert.equal((await message("send",i,s)).state,"accepted");assert.equal(await count(r),1);
   const begin=Date.now();await stopService();assert.ok(Date.now()-begin<4000);
  });
 }finally{
  await stopService();await watcher?.close();await t3.stop();for(const nc of connections)await nc.close();await stop();
  for(const key of Object.values(keys))key.clear();rmSync(root,{recursive:true,force:true});
 }
});
