import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { EventStore } from "../../src/akasha/store.ts";
import { eventPage } from "../../src/akasha/compat.ts";
import { hash, type Envelope } from "../../src/akasha/schema.ts";
import type { Scope } from "../../src/akasha/auth.ts";
import { emptyCache, mergeStatus } from "../../src/mission-control/cache.ts";
import { refreshStatus, type ReaderConfig } from "../../src/mission-control/reader.ts";
import type { HostSnapshot } from "../../src/mission-control/contract.ts";

const start=Date.parse("2026-10-23T23:55:32.903Z");
const config:ReaderConfig={url:"https://akasha.fixture",tokenHelper:"/unused",source:"mission-control-reader",host:"omarchy-normandy",profile:"mission-control-reader",project:"chaldea",allowedSourceIds:["agent-a--mission-control"],cacheFile:"/unused",refreshMs:5000};
const scope:Scope={issuer:"chaldea:omarchy-normandy",profile:config.profile,project:config.project,source:config.source,host:config.host,global:false,missionControlSources:config.allowedSourceIds};
const sample=(sequence:number):HostSnapshot=>({schema:"mission-control.host.v1",host:"agent-a",epoch:"a".repeat(32),sequence,observedAt:start-5000+(sequence-2)*5000,connected:true,total:0,truncated:false,agents:[],tokens:{qualified:false,output:null,rate:null,observedAt:null,coverage:"unknown"}});
function envelope(receivedAt:number):Envelope {
  const snapshot=sample(2);
  return {v:1,event_id:hash(["late-admission",receivedAt]),source_id:"agent-a--mission-control",issuer:"chaldea:agent-a",profile:"mission-control-publisher",project:"chaldea",source:"agent-a.mission-control",host:"agent-a",run_id:"fixture",kind:"agent_status",occurred_at:new Date(snapshot.observedAt).toISOString(),received_at:new Date(receivedAt).toISOString(),severity:"info",title:"Mission control status",body:"",tags:[],link:"",data:{snapshot},provenance:{type:"verified",request_hash:hash("fixture"),feed_id:null}};
}
for(const phase of ["token","body"] as const)test("reader accepts in-window status admitted during "+phase+" and still rejects future receipt times",async()=>{
  const root=process.env.CHALDEA_TEST_SCRATCH;
  assert.ok(root&&!root.startsWith("/tmp"));
  const dir=mkdtempSync(join(root,"reader-"));
  try{
    for(const future of [false,true]){
      const store=new EventStore(join(dir,String(future)+".db"),{initialize:true});
      try{
        let clock=start;
        const previous=emptyCache();mergeStatus(previous,sample(1),clock);
        const e=envelope(start+1000+(future?1001:0));
        const nowSeconds=Math.floor(start/1000);
        store.admit(e,e.provenance.request_hash,nowSeconds);store.project(e,1,nowSeconds);
        const urls:string[]=[];
        const dependencies={
          now:()=>clock,
          token:async()=>{if(phase==="token")clock=start+1000;return "fixture";},
          fetch:(async(input)=>{
            const url=new URL(String(input));urls.push(url.href);
            const page=eventPage(store,url.searchParams,scope,Math.floor(clock/1000));
            const events=[...page.rows];
            assert.equal(events.length,1,"real event query selects producer time, including later server admission");
            return new Response(new ReadableStream({start(controller){
              controller.enqueue(Buffer.from(JSON.stringify({events,next_cursor:page.next()})));
            },pull(controller){clock=start+2000;controller.close();}}));
          }) as typeof fetch,
        };
        const result=await refreshStatus(config,previous,dependencies);
        assert.equal(result.gap,future,"only a receipt beyond response completion is a gap");
        assert.equal(result.snapshots[0]!.sequence,future?1:2);
        assert.equal(result.snapshots[0]!.observedAt,sample(future?1:2).observedAt);
        assert.equal(previous.gap,false);assert.equal(previous.snapshots[0]!.sequence,1);
        assert.equal(new URL(urls[0]!).searchParams.get("to"),new Date(start).toISOString());
        if(!future){
          const failed=await refreshStatus(config,result,{now:()=>clock,token:async()=>{throw new Error("unavailable");}});
          assert.equal(failed.gap,true);assert.deepEqual(failed.snapshots,result.snapshots);
          const recovered=await refreshStatus(config,failed,dependencies);
          assert.equal(recovered.gap,false);assert.deepEqual(recovered.snapshots,result.snapshots);
        }
      }finally{store.close();}
    }
  }finally{rmSync(dir,{recursive:true,force:true});}
});
