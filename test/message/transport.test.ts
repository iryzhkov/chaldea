import assert from "node:assert/strict";
import test from "node:test";
import { spawn, type ChildProcess } from "node:child_process";
import { writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createServer, createConnection } from "node:net";
import { once } from "node:events";
import { nkeys, type NatsConnection } from "@nats-io/transport-node";
import { connection, brokerConfig } from "../../src/message-broker.ts";
import { scratchDir } from "../helpers/scratch.ts";
const delay=(ms:number)=>new Promise(r=>setTimeout(r,ms));
async function port():Promise<number> {
  const listener=createServer();listener.listen(0,"127.0.0.1");await once(listener,"listening");
  const n=(listener.address() as {port:number}).port;await new Promise<void>(r=>listener.close(()=>r()));return n;
}
async function within<T>(promise:Promise<T>,ms:number):Promise<T> {
  let timer:ReturnType<typeof setTimeout>|undefined;
  try {return await Promise.race([promise,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error("fixture deadline")),ms);})]);}
  finally {clearTimeout(timer);}
}
test("production transport verifies TLS/WSS certificates and evicts revoked NKeys on reload",{timeout:60000},async()=>{
  assert.notEqual(homedir(),"/home/igor");assert.notEqual(homedir(),"/root");
  assert.ok(process.env.NATS_SERVER);assert.ok(process.env.MESSAGE_CERT_DIR);
  const certs=process.env.MESSAGE_CERT_DIR;
  assert.equal(process.env.NODE_EXTRA_CA_CERTS,join(certs,"trusted.crt"));
  assert.notEqual(process.env.NODE_TLS_REJECT_UNAUTHORIZED,"0");
  writeFileSync("message-transport-proof.json",JSON.stringify({passed:false})+"\n");
  const dir=scratchDir("message-transport"),plain=await port(),web=await port(),file=join(dir.path,"nats.conf");
  const keys={old:nkeys.createUser(),next:nkeys.createUser()};
  const connections:NatsConnection[]=[];
  let server:ChildProcess|undefined;
  const b=(scheme:"tls"|"wss",who:keyof typeof keys,host="localhost")=>brokerConfig({
    url:scheme+"://"+host+":"+(scheme==="tls"?plain:web)+"/",account:"MESSAGES",
    seedFile:join(dir.path,who+".seed"),publicKey:keys[who].getPublicKey(),
    inboxPrefix:"_INBOX_message."+who,commandStream:"MESSAGE_COMMANDS",receiptStream:"MESSAGE_RECEIPTS"});
  for(const [name,key]of Object.entries(keys))writeFileSync(join(dir.path,name+".seed"),key.getSeed(),{mode:0o600});
  function config(who:keyof typeof keys,certificate="trusted") {
    const tls={cert_file:join(certs,certificate+".crt"),key_file:join(certs,certificate+".key")};
    writeFileSync(file,JSON.stringify({host:"127.0.0.1",port:plain,tls,
      websocket:{host:"127.0.0.1",port:web,tls},
      accounts:{MESSAGES:{users:[{nkey:keys[who].getPublicKey(),permissions:{
        publish:["chaldea.message.command.fixture.target"],subscribe:["_INBOX_message."+who+".>"]}}]}}
    }),{mode:0o600});
  }
  async function start() {
    server=spawn(process.env.NATS_SERVER!,["-c",file],{stdio:"ignore"});
    for(let i=0;i<100;i++) {
      assert.equal(server.exitCode,null,"fixture broker exited");
      const ready=await new Promise<boolean>(resolve=>{
        const socket=createConnection({host:"127.0.0.1",port:plain});
        socket.setTimeout(100);socket.once("connect",()=>{socket.destroy();resolve(true);});
        socket.once("error",()=>{socket.destroy();resolve(false);});
        socket.once("timeout",()=>{socket.destroy();resolve(false);});
      });
      if(ready)return;await delay(30);
    }
    throw Error("fixture broker startup timeout");
  }
  async function stop() {
    if(server && server.exitCode===null) {const done=once(server,"close");server.kill("SIGTERM");await within(done,5000);}
  }
  async function open(scheme:"tls"|"wss",who:keyof typeof keys) {
    const nc=await connection(b(scheme,who));connections.push(nc);await nc.flush();return nc;
  }
  try {
    config("old");await start();
    const old=[await open("tls","old"),await open("wss","old")];
    for(const scheme of ["tls","wss"] as const) {
      await assert.rejects(connection(b(scheme,"old","127.0.0.1")),/message_broker_unavailable/);
      await assert.rejects(connection(b(scheme,"next")),/message_broker_unavailable/);
    }
    // Config reload removes the old authenticated identity and must also evict
    // its already-established TLS and WSS connections, not just reject reconnect.
    config("next");assert.equal(server!.kill("SIGHUP"),true);
    await within(Promise.all(old.map(nc=>nc.closed())),5000);
    for(const scheme of ["tls","wss"] as const) {
      await assert.rejects(connection(b(scheme,"old")),/message_broker_unavailable/);
      await (await open(scheme,"next")).close();
    }
    await stop();
    config("next","untrusted");await start();
    for(const scheme of ["tls","wss"] as const)
      await assert.rejects(connection(b(scheme,"next")),/message_broker_unavailable/);
    writeFileSync("message-transport-proof.json",JSON.stringify({passed:true,proof:"isolated-production-transport",
      nats:"2.15.1",tls:true,wss:true,hostnameMismatchDenied:true,untrustedCertificateDenied:true,
      unenrolledKeyDenied:true,oldConnectionsEvicted:true,revokedKeyDenied:true,replacementKeyAccepted:true,
      liveEnrollment:false,targetLocalRenewal:false})+"\n");
  } finally {
    for(const nc of connections)await nc.close();
    await stop();keys.old.clear();keys.next.clear();dir.remove();
  }
});
