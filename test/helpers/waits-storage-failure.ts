// Child-process fault injection: fake T3, private disposable SQLite only.
import { writeSync } from "node:fs";
import { WakeStore } from "../../src/wake/store.ts";
import { WaitEngine } from "../../src/waits/engine.ts";
import type { WaitT3 } from "../../src/t3/waits.ts";
const [path,mode]=process.argv.slice(2);
const store=new WakeStore(path!,"test-env");
const fault=() => { writeSync(1,"storage_fault\n");throw new Error(mode==="receipt" ? "Fake ENOSPC" : "Fake EIO"); };
const t3:WaitT3={
  async environment(){return "test-env";},
  async snapshot(id){return {id,project:"project",archived:false,deleted:false,settled:false,runs:[],pendingRuns:[],children:[]};},
  async observe(_id,signal){if(!signal.aborted)await new Promise<void>(r=>signal.addEventListener("abort",()=>r(),{once:true}));},
  async dispatch(){},
};
if(mode==="receipt"){
  for(let i=0;i<2;i++){
    const now=Date.now();
    const row=store.register(store.prepare("wait",{threadId:"parent-"+i,requestId:now+":fatal"+i,
      condition:{kind:"time",at:new Date(now).toISOString()}}),"project",null);
    store.resolve(row.id,{reason:"time"});
  }
  store.sent=fault;
}else if(mode==="tracking")store.nativeTracking=fault;
else store.maintain=fault;
const engine=new WaitEngine(store,t3,{answerBaseUrl:"http://127.0.0.1:7385",report(event){
  if(event!=="watcher_needs_attention")return;
  // Must refuse another registration during the moment before the scheduled exit.
  void engine.register("wait",{}).then(()=>process.exit(9),error=>writeSync(1,error.message+"\n"));
  if(mode==="logger"){writeSync(1,"report_attempt\n");throw new Error("Fake log ENOSPC");}
  writeSync(1,event+"\n");
}});
if(mode==="tracking")for(let n=0;n<2;n++)try{engine.trackedNative("parent");}catch{}
engine.start();engine.poke();
