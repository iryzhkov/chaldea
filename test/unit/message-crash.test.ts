import { receiver,transport } from "../helpers/message-config.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { MessageStore } from "../../src/message-store.ts";
import { receiverBinding, type ReceiverConfig } from "../../src/message-receiver.ts";
test("process death at intent, T3 commit and receipt commit never invents acceptance or new command bytes",()=>{
  assert.notEqual(homedir(),"/home/igor");assert.notEqual(homedir(),"/root");
  const base=join(homedir(),"message-crashes");mkdirSync(base,{recursive:true,mode:0o700});
  for(const phase of ["intent","dispatch","receipt"]){
    const dir=mkdtempSync(join(base,"t-")),now=Date.now();
    try{
      const c=receiver(dir);
      new MessageStore(c.database,receiverBinding(c),true).close();
      const run=(phase:string)=>spawnSync(process.execPath,[resolve("test/helpers/message-crash.ts"),JSON.stringify(c),phase,String(now)],
        {env:{PATH:process.env.PATH,HOME:homedir(),TMPDIR:process.env.TMPDIR},encoding:"utf8",timeout:10_000});
      const crashed=run(phase);assert.equal(crashed.status,17,crashed.stderr);
      const s=new MessageStore(c.database,receiverBinding(c));
      const rows=s.db.prepare("SELECT * FROM receipts").all() as Array<{state:string;payload:string|null}>;
      assert.equal(rows.length,1);assert.equal(rows[0]!.state,phase==="receipt"?"accepted":"dispatching");
      const original=rows[0]!.payload;s.close();
      const resumed=run("resume");assert.equal(resumed.status,0,resumed.stderr);assert.equal(JSON.parse(resumed.stdout).state,"accepted");
      const dispatches=existsSync(c.database+".dispatches")?readFileSync(c.database+".dispatches","utf8").trim().split("\n"):[];
      assert.equal(dispatches.length,phase==="dispatch"?2:1,"only an explicit retry may replay an uncertain call");
      assert.ok(dispatches.every(line=>line===dispatches[0]));
      if(original)assert.equal(dispatches[0],original);
    }finally{rmSync(dir,{recursive:true,force:true});}
  }
});
