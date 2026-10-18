// Process-death fixture. No live T3 or credentials.
import { appendFileSync, closeSync, fsyncSync, openSync } from "node:fs";
import { MessageStore } from "../../src/message-store.ts";
import { receiverBinding, receive, type ReceiverConfig } from "../../src/message-receiver.ts";
import { request } from "../../src/message.ts";
const [configuration,phase,stamp]=process.argv.slice(2) as [string,string,string];
const c=JSON.parse(configuration) as ReceiverConfig,now=Number(stamp);
const r=request({v:1,op:"send",host:c.host,environment:c.environment,threadId:"thread",requestId:now+":process",text:"immutable process payload"});
const x={caller:"pc",originalCommand:"chaldea-message-v1",connection:"127.0.0.1 1234 127.0.0.1 22"};
const s=new MessageStore(c.database,receiverBinding(c));
try{
  const result=await receive(r,x,c,s,()=>c,()=>({
    async preflight(){if(phase==="intent")process.exit(17);return true;},
    async dispatch(bytes:string){
      appendFileSync(c.database+".dispatches",bytes+"\n",{mode:0o600});
      const fd=openSync(c.database+".dispatches","r");fsyncSync(fd);closeSync(fd);
      if(phase==="dispatch")process.exit(17);
    },
  }),now);
  if(phase==="receipt")process.exit(17);
  process.stdout.write(JSON.stringify(result));
}finally{s.close();}
