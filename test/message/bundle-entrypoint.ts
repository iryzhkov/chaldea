// Status-only reproduction: no SSH account, bearer or T3 dispatch.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { MessageStore } from "../../src/message-store.ts";
import { receiverBinding, type ReceiverConfig } from "../../src/message-receiver.ts";
assert.equal(process.geteuid!(),0,"run only in the disposable job or hosted root fixture");
assert.notEqual(homedir(),"/home/igor");assert.notEqual(homedir(),"/root");
const dir=mkdtempSync(join(homedir(),"message-bundle-"));
try {
  const state=join(dir,"state");mkdirSync(state,{mode:0o700});
  const c:ReceiverConfig={host:"target",environment:"fixture",loopbackT3Url:"http://127.0.0.1:1",tokenFile:join(state,"absent-token"),
    database:join(state,"receipts.db"),callers:{fixture:{sourceHost:"source",sourceAddresses:["127.0.0.1"],threads:["thread"]}}};
  const config=join(dir,"receiver.json"),bundle=join(dir,"receiver.mjs");
  writeFileSync(config,JSON.stringify(c),{mode:0o644});
  new MessageStore(c.database,receiverBinding(c),true).close();
  writeFileSync(config+".env-checked","",{mode:0o600});
  execFileSync(resolve("node_modules/.bin/esbuild"),["test/helpers/message-receiver-fixture.ts","--bundle","--platform=node","--format=esm",
    "--packages=bundle","--banner:js=import {createRequire} from 'node:module';const require=createRequire(import.meta.url);","--outfile="+bundle],{stdio:"ignore"});
  const input=JSON.stringify({v:1,op:"status",host:c.host,environment:c.environment,threadId:"thread",requestId:Date.now()+":status"});
  const env={PATH:"/usr/bin:/bin",SSH_CONNECTION:"127.0.0.1 1234 127.0.0.1 22",SSH_ORIGINAL_COMMAND:"chaldea-message-v1"};
  const control=spawnSync(process.execPath,[resolve("src/message-receiver.ts"),config,"fixture"],{input,encoding:"utf8",timeout:10_000,env});
  assert.equal(control.status,0,"direct production receiver status control");
  assert.equal(JSON.parse(control.stdout).state,"uncertain");
  const result=spawnSync(process.execPath,[bundle,config,"fixture"],{input,encoding:"utf8",timeout:10_000,env});
  // Only fixed wire state and process status, never request/body/credential/error text.
  console.log(JSON.stringify({probe:"bundle-status",exit:result.status,signal:result.signal,states:result.stdout.split("\n").filter(Boolean).map(line=>JSON.parse(line).state)}));
  assert.equal(result.status,0,"bundled fixture must consume stdin once and exit successfully");
  assert.equal(JSON.parse(result.stdout).state,"uncertain","exactly one valid status response");
}finally{rmSync(dir,{recursive:true,force:true});}
