// Runs ONLY as root on a GitHub-hosted ephemeral runner. No host/fleet credential.
import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, mkdirSync, chmodSync, chownSync, copyFileSync, writeFileSync, readFileSync, rmSync, existsSync, statSync, unlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { createServer, createConnection, type AddressInfo } from "node:net";
import * as Effect from "effect/Effect";
import { DatabaseSync } from "node:sqlite";
import { startDisposableT3, t3Version } from "../helpers/disposable-t3.ts";
import { ShellWatcher, waitFor } from "../helpers/e2e.ts";
import { withClient } from "../../src/t3/adapter.ts";
import { MessageStore } from "../../src/message-store.ts";
import { readTrustedFile, ConfigurationError } from "../../src/config/files.ts";
import { receiverBinding, payload, type ReceiverConfig } from "../../src/message-receiver.ts";
import { identity, request, message, senderBinding, sshRequest, sshArgs, type SenderConfig, type Route } from "../../src/message.ts";

async function port():Promise<number>{
  const s=createServer();await new Promise<void>(r=>s.listen(0,"127.0.0.1",r));
  const p=(s.address() as AddressInfo).port;await new Promise<void>(r=>s.close(()=>r()));return p;
}
async function collected(child:ChildProcess,body="",limit=10_000){
  let out="",err="";
  child.stdout?.on("data",b=>out=(out+b).slice(-32768));child.stderr?.on("data",b=>err=(err+b).slice(-4096));
  child.stdin?.on("error",()=>{});child.stdin?.end(body);
  const timer=setTimeout(()=>child.kill("SIGKILL"),limit);
  const code=await new Promise<number|null>((resolve,reject)=>{child.once("error",reject);child.once("close",resolve);});
  clearTimeout(timer);return {code,out,err};
}
test("stock SSH: restricted key, static login shell, queued real T3, replay and all channel refusals",{timeout:180_000},async t=>{
  assert.equal(process.env.GITHUB_ACTIONS,"true");assert.equal(process.env.RUNNER_ENVIRONMENT,"github-hosted");
  assert.equal(process.geteuid!(),0,"fixture account creation is limited to the ephemeral hosted runner");
  assert.notEqual(homedir(),"/root");assert.ok(homedir().startsWith(process.env.RUNNER_TEMP!+"/"));
  assert.equal(t3Version(),"t3 v0.1.0","pinned T3 is mandatory");
  const base=join(homedir(),"message-ssh");mkdirSync(base,{recursive:true,mode:0o755});chmodSync(homedir(),0o755);
  const dir=mkdtempSync(join(base,"t-"));chmodSync(dir,0o755);
  const root=join(dir,"root"),state=join(dir,"state");mkdirSync(root,{mode:0o755});mkdirSync(state,{mode:0o700});
  const user="chaldea-message",config=join(root,"receiver.json"),node=join(root,"node"),binary=join(root,"launcher"),bundle=join(root,"receiver.mjs");
  let daemon:ChildProcess|undefined,watcher:ShellWatcher|undefined,created=false,log="",t3:Awaited<ReturnType<typeof startDisposableT3>>|undefined;
  const cleanupClients:ChildProcess[]=[];
  const run=(cmd:string,args:string[])=>execFileSync(cmd,args,{encoding:"utf8",stdio:["ignore","pipe","pipe"],timeout:30_000});
  try{
    assert.notEqual(spawnSync("getent",["passwd",user]).status,0,"refuse any pre-existing account");
    assert.equal(existsSync("/etc/ssh/sshrc"),false,"system sshrc would run an interpreter before the static login shell");
    t.diagnostic(run(process.execPath,["test/message/bundle-entrypoint.ts"]).trim());
    run(resolve("node_modules/.bin/esbuild"),["test/helpers/message-receiver-fixture.ts","--bundle","--platform=node","--format=esm","--packages=bundle","--banner:js=import {createRequire} from 'node:module';const require=createRequire(import.meta.url);","--outfile="+bundle]);
    copyFileSync(process.execPath,node);chownSync(node,0,0);chmodSync(node,0o755);
    chownSync(bundle,0,0);chmodSync(bundle,0o644);
    run("cc",["-static","-O2","-Wall","-Wextra","-Werror","-DMESSAGE_NODE="+JSON.stringify(node),"-DMESSAGE_RECEIVER="+JSON.stringify(bundle),
      "-DMESSAGE_CONFIG="+JSON.stringify(config),"-o",binary,resolve("host/chaldea-message-launcher.c")]);chmodSync(binary,0o755);
    assert.doesNotMatch(run("readelf",["-l",binary]),/INTERP/);assert.doesNotMatch(run("readelf",["-d",binary]),/NEEDED/);
    for(const p of [root,node,binary,bundle]){assert.equal(statSync(p).uid,0,"fixture root ownership: "+p);assert.equal(statSync(p).mode&0o022,0,"fixture write modes: "+p);}
    const login=join(root,"login");mkdirSync(login,{mode:0o755});
    run("useradd",["--no-create-home","--home-dir",login,"--shell",binary,"--password","*",user]);created=true;
    const uid=Number(run("id",["-u",user]).trim()),gid=Number(run("id",["-g",user]).trim());
    for(const key of ["host","client"])run("ssh-keygen",["-q","-t","ed25519","-N","","-f",join(root,key)]);
    const clientKey=join(root,"client"),known=join(root,"known_hosts"),sshPort=await port();
    writeFileSync(known,"[127.0.0.1]:"+sshPort+" "+readFileSync(join(root,"host.pub"),"utf8"));
    const forced="/usr/local/libexec/chaldea-message-receive --caller fixture";
    // Keep strict ownership checking within the fixture account\'s root-owned login home.
    const authorized=join(login,"authorized_keys"),publicKey=readFileSync(clientKey+".pub","utf8").trim();
    writeFileSync(authorized,'restrict,from="127.0.0.1",command="'+forced+'" '+publicKey+"\n",{mode:0o644});
    const sshd=join(root,"sshd.conf");
    const policy="Port "+sshPort+"\nListenAddress 127.0.0.1\nHostKey "+join(root,"host")+"\nPidFile "+join(root,"sshd.pid")+"\n"+
      "UsePAM no\nPermitRootLogin no\nStrictModes yes\nPermitUserEnvironment no\nLogLevel DEBUG1\nAllowUsers "+user+"\n"+
      "AcceptEnv NODE_OPTIONS BASH_ENV ENV LD_PRELOAD LD_LIBRARY_PATH SSH_AUTH_SOCK\n"+
      "Subsystem sftp internal-sftp\nMatch User "+user+"\n"+
      "  AuthenticationMethods publickey\n  PubkeyAuthentication yes\n  PasswordAuthentication no\n  KbdInteractiveAuthentication no\n"+
      "  HostbasedAuthentication no\n  GSSAPIAuthentication no\n  AuthorizedKeysFile "+authorized+"\n  AuthorizedKeysCommand none\n"+
      "  TrustedUserCAKeys none\n  AuthorizedPrincipalsFile none\n  PermitUserRC no\n  PermitTTY no\n  DisableForwarding yes\n"+
      "  AllowAgentForwarding no\n  AllowTcpForwarding no\n  AllowStreamLocalForwarding no\n  X11Forwarding no\n  PermitTunnel no\n"+
      "  PermitOpen none\n  PermitListen none\n  MaxSessions 1\n";
    writeFileSync(sshd,policy,{mode:0o600});
    run("/usr/sbin/sshd",["-t","-f",sshd]);
    const effective=run("/usr/sbin/sshd",["-T","-f",sshd,"-C","user="+user+",addr=127.0.0.1,host=localhost"]);
    for(const [key,value] of Object.entries({permituserenvironment:"no",forcecommand:"none",authenticationmethods:"publickey",
      passwordauthentication:"no",kbdinteractiveauthentication:"no",hostbasedauthentication:"no",gssapiauthentication:"no",
      permituserrc:"no",permittty:"no",disableforwarding:"yes",allowagentforwarding:"no",allowtcpforwarding:"no",
      allowstreamlocalforwarding:"no",x11forwarding:"no",permittunnel:"no",maxsessions:"1",authorizedkeyscommand:"none",trustedusercakeys:"none"}))
      assert.ok(effective.split("\n").includes(key+" "+value),key+" effective policy");
    t.diagnostic("stock sshd -t and effective -T -C policy passed; no overriding ForceCommand");
    t3=await startDisposableT3({scratchRoot:join(dir,"t3"),scenario:"no-reset",autoResume:false});
    const token=t3.issueToken(["orchestration:read","orchestration:operate"]),opts=()=>({serverUrl:t3!.serverUrl,token});
    watcher=new ShellWatcher(t3.serverUrl,token);
    const threadId=await waitFor("bootstrap thread",()=>watcher!.firstThreadId(),30_000);
    const environment=await withClient(opts(),c=>c["server.getConfig"]({}).pipe(Effect.map(c=>String(c.environment.environmentId))));
    const c:ReceiverConfig={host:"target",environment,loopbackT3Url:t3.serverUrl,tokenFile:join(state,"token"),database:join(state,"receipts.db"),
      callers:{fixture:{sourceHost:"source",sourceAddresses:["127.0.0.1"],threads:[threadId]}}};
    writeFileSync(config,JSON.stringify(c),{mode:0o644});writeFileSync(config+".env-checked","",{mode:0o600});chownSync(config+".env-checked",uid,gid);
    writeFileSync(c.tokenFile,token,{mode:0o600});chownSync(c.tokenFile,uid,gid);
    const s=new MessageStore(c.database,receiverBinding(c),true);s.close();
    for(const p of [c.database,c.database+".lock",state])chownSync(p,uid,gid);
    // Requested creation modes are masked by the runner's inherited umask.
    const publicPaths=[["base",base,0o755],["runtime",root,0o755],["login",login,0o755],
      ["authorized_keys",authorized,0o644],["config",config,0o644]] as const;
    const readable=()=>spawnSync("runuser",["-u",user,"--","/usr/bin/test","-r",authorized],{stdio:"ignore"}).status===0;
    const readableBefore=readable(),modesBefore=publicPaths.map(([label,p])=>[label,(statSync(p).mode&0o777).toString(8)]);
    const blockedAncestors:string[]=[];
    for(let p=dirname(authorized);p!==dirname(p);p=dirname(p))
      if(spawnSync("runuser",["-u",user,"--","/usr/bin/test","-x",p],{stdio:"ignore"}).status!==0)blockedAncestors.push(p);
    for(const [,p,mode] of publicPaths){assert.equal(statSync(p).uid,0,"fixture public custody: "+p);chmodSync(p,mode);}
    t.diagnostic(JSON.stringify({probe:"fixture-public-access",umask:process.umask().toString(8),modesBefore,blockedAncestors,readableBefore,readableAfter:readable()}));
    assert.ok(readable(),"fixture UID must be able to read its root-owned restricted authorized_keys");
    const route:Route={destinationHost:"target",environment,address:"127.0.0.1",port:sshPort,keyFile:clientKey,knownHostsFile:known,threads:[threadId]};
    const sender:SenderConfig={callerId:"fixture",sourceHost:"source",database:join(root,"sender/state.db"),hosts:{target:route}};
    const ss=new MessageStore(sender.database,senderBinding(sender),true);ss.close();
    daemon=spawn("/usr/sbin/sshd",["-D","-e","-f",sshd],{stdio:["ignore","ignore","pipe"]});
    daemon.stderr!.on("data",b=>log=(log+b).slice(-32768));
    const deadline=Date.now()+5000;
    for(;;){
      const connected=await new Promise<boolean>(r=>{const s=createConnection(sshPort,"127.0.0.1");s.once("connect",()=>{s.destroy();r(true);});s.once("error",()=>r(false));});
      if(connected)break;assert.ok(Date.now()<deadline,"fixture sshd did not listen");await new Promise(r=>setTimeout(r,30));
    }
    const common=["-F","/dev/null","-p",String(sshPort),"-i",clientKey,"-o","BatchMode=yes","-o","IdentitiesOnly=yes",
      "-o","IdentityAgent=none","-o","StrictHostKeyChecking=yes","-o","UserKnownHostsFile="+known,"-o","GlobalKnownHostsFile=/dev/null",
      "-o","ControlMaster=no","-o","ConnectTimeout=5"];
    const ssh=(command:string[]= ["chaldea-message-v1"],extra:string[]=[],body="",env:NodeJS.ProcessEnv={})=>
      collected(spawn("/usr/bin/ssh",[...common,...extra,user+"@127.0.0.1",...command],{
        env:{PATH:"/usr/bin:/bin",...env},stdio:["pipe","pipe","pipe"]}),body);
    // [DEBUG-m1ssh] Status-only transport diagnosis. Never emit raw stderr or wire data.
    for(const [label,file,secret] of [["key",clientKey,true],["known_hosts",known,false]] as const){
      try{readTrustedFile(file,{secret,maxBytes:secret?16384:65536});}
      catch(e){assert.fail(JSON.stringify({probe:"custody",file:label,reason:e instanceof ConfigurationError?e.reason:"read"}));}
    }
    const probe=request({v:1,op:"status",host:"target",environment,threadId,requestId:Date.now()+":transport-probe"});
    const transport=await collected(spawn("/usr/bin/ssh",["-vv",...sshArgs(route)],{
      env:{PATH:"/usr/bin:/bin"},stdio:["pipe","pipe","pipe"]}),JSON.stringify(probe),35_000);
    const flags=(text:string)=>Object.fromEntries(Object.entries({
      authenticated:/Authenticated to /,keyAccepted:/Server accepts key:/,permissionDenied:/Permission denied/i,
      accountLocked:/account is locked/i,badOwnership:/bad ownership or modes/i,notFound:/No such file or directory/i,
      loader:/error while loading shared libraries/i,envRefused:/env request failed/i,
      commandStarted:/Sending command: chaldea-message-v1/,connectionClosed:/Connection closed/i,
    }).map(([key,re])=>[key,re.test(text)]));
    let probeState="invalid";
    try{const value=JSON.parse(transport.out);if(["accepted","rejected","uncertain","conflict"].includes(value.state))probeState=value.state;}catch{}
    t.diagnostic(JSON.stringify({probe:"ssh-status",exit:transport.code,stdoutBytes:Buffer.byteLength(transport.out),state:probeState,
      client:flags(transport.err),server:flags(log),envChecked:readFileSync(config+".env-checked","utf8").includes("clean")}));
    assert.equal(transport.code,0,"status-only SSH transport must succeed before any send");
    assert.equal(probeState,"uncertain","absent receipt has one uncertain status response");
    const r=request({v:1,op:"send",host:"target",environment,threadId,requestId:Date.now()+":ssh-success",text:"$(touch "+join(state,"injected")+"); literal shell data"});
    const before=await withClient(opts(),c=>c["orchestration.getThreadProjection"]({threadId} as never));
    let firstReply:Awaited<ReturnType<typeof sshRequest>>|undefined;
    const first=await message("send",{host:"target",threadId,requestId:r.requestId,text:r.text},sender,async(h,r)=>{
      firstReply=await sshRequest(h,r);throw new Error("discard reply");
    });
    assert.equal(firstReply?.state,"accepted",JSON.stringify(firstReply??{error:"no_response"}));
    assert.equal(first.state,"uncertain");
    const replay=await message("send",{host:"target",threadId,requestId:r.requestId,text:r.text},sender);
    assert.equal(replay.state,"accepted");
    const p=await withClient(opts(),c=>c["orchestration.getThreadProjection"]({threadId} as never));
    assert.equal(p.messages.filter(m=>m.id===identity("fixture","source",r).messageId).length,1);
    assert.deepEqual(p.thread.modelSelection,before.thread.modelSelection);assert.equal(existsSync(join(state,"injected")),false);
    t.diagnostic("actual SSH send, lost-response identical replay and unchanged model passed");
    const conflict=await ssh(["chaldea-message-v1"],[],JSON.stringify({...r,text:"changed"}));
    assert.equal(conflict.code,0,conflict.err);assert.equal(JSON.parse(conflict.out).state,"conflict");
    for(const invalid of [{...statusFor(r),host:"other"},{...statusFor(r),environment:"other"},{...statusFor(r),threadId:"unlisted"},
      {...r,caller:"other"},{...r,extra:true}])assert.notEqual((await ssh(["chaldea-message-v1"],[],JSON.stringify(invalid))).code,0);
    const older={...r,requestId:(Date.now()-60_000)+":older",text:"out of order distinct request"};
    const outOfOrder=await ssh(["chaldea-message-v1"],[],JSON.stringify(older));
    assert.equal(outOfOrder.code,0,outOfOrder.err);assert.equal(JSON.parse(outOfOrder.out).state,"accepted");
    function statusFor(r:ReturnType<typeof request>){const {text,...s}=r;return {...s,op:"status"};}
    const marker=join(state,"environment-injected"),shell=join(root,"hostile.sh"),source=join(root,"hostile.c"),library=join(root,"hostile.so");
    writeFileSync(shell,"touch "+marker+"\n");
    writeFileSync(source,'#include <stdio.h>\n__attribute__((constructor)) static void injected(void){FILE *f=fopen('+JSON.stringify(marker)+',"w");if(f)fclose(f);}\n');
    run("cc",["-shared","-fPIC","-o",library,source]);chmodSync(library,0o755);
    // SetEnv sends values without poisoning the SSH client process itself.
    const hostile=["NODE_OPTIONS=--import="+shell,"BASH_ENV="+shell,"ENV="+shell,"LD_PRELOAD="+library,"LD_LIBRARY_PATH="+root,"SSH_AUTH_SOCK="+marker,
      "SSH_ORIGINAL_COMMAND=chaldea-message-v1",'SSH_CONNECTION="127.0.0.2 1 127.0.0.1 22"'];
    const status={...r,op:"status"};delete status.text;
    const envResult=await ssh(["chaldea-message-v1"],hostile.flatMap(e=>["-o","SetEnv="+e]),JSON.stringify(status));
    assert.equal(envResult.code,0,envResult.err);assert.equal(JSON.parse(envResult.out).state,"accepted");assert.equal(existsSync(marker),false);
    assert.ok(readFileSync(config+".env-checked","utf8").includes("clean"));
    for(const command of [[],["sh"],["chaldea-message-v1 "],["chaldea-message-v1; id"],["scp -t /x"]]){
      const negative=await ssh(command,[],JSON.stringify(r));assert.notEqual(negative.code,0,"command must be refused: "+JSON.stringify(command));
    }
    assert.notEqual((await ssh([],["-o","SetEnv=SSH_ORIGINAL_COMMAND=chaldea-message-v1"],JSON.stringify(r))).code,0,"shell cannot spoof original command");
    assert.notEqual((await ssh(["sftp"],["-s"],JSON.stringify(r))).code,0,"subsystem refused");
    const pty=await ssh(["chaldea-message-v1"],["-tt"],JSON.stringify(status));assert.match(pty.err,/PTY allocation request failed/i);
    assert.notEqual((await ssh([],["-W","127.0.0.1:"+sshPort])).code,0,"direct TCP forwarding refused");
    assert.notEqual((await ssh([],["-N","-o","ExitOnForwardFailure=yes","-R","0:127.0.0.1:"+sshPort])).code,0,"remote TCP forwarding refused");
    assert.notEqual((await ssh([],["-N","-o","ExitOnForwardFailure=yes","-R",join(state,"remote.sock")+":127.0.0.1:"+sshPort])).code,0,"remote StreamLocal forwarding refused");
    assert.notEqual((await ssh([],["-N","-o","ExitOnForwardFailure=yes","-w","any:any"])).code,0,"tunnel refused");
    // Force a real direct-streamlocal channel attempt through a local socket.
    const localSocket=join(root,"local.sock"),remoteSocket=join(state,"forbidden.sock");
    const forwarding=spawn("/usr/bin/ssh",[...common,"-v","-N","-L",localSocket+":"+remoteSocket,user+"@127.0.0.1"],
      {env:{PATH:"/usr/bin:/bin"},stdio:["ignore","ignore","pipe"]});
    cleanupClients.push(forwarding);let forwardError="";
    forwarding.stderr!.on("data",b=>forwardError=(forwardError+b).slice(-8192));
    await waitFor("local StreamLocal listener",()=>existsSync(localSocket),5000);
    const channel=createConnection(localSocket);channel.on("error",()=>{});
    const ended=new Promise<void>(r=>channel.once("close",()=>r()));
    channel.end("forbidden");
    await Promise.race([ended,new Promise((_,reject)=>setTimeout(()=>reject(new Error("StreamLocal did not refuse")),5000).unref())]);
    await waitFor("remote StreamLocal denial",()=>/administratively prohibited/i.test(forwardError),5000);
    forwarding.kill("SIGTERM");await new Promise<void>(r=>forwarding.once("close",()=>r()));
    // Supply a real local agent socket so the client actually requests agent forwarding.
    const agentPath=join(root,"agent.sock"),agentServer=createServer(socket=>socket.destroy());
    await new Promise<void>(r=>agentServer.listen(agentPath,r));
    try {
      const agent=await ssh(["chaldea-message-v1"],["-v","-A","-X","-o","ForwardX11Trusted=yes"],JSON.stringify(status),
        {DISPLAY:"localhost:99.0",SSH_AUTH_SOCK:agentPath});
      assert.equal(agent.code,0,agent.err);assert.equal(JSON.parse(agent.out).state,"accepted");
      assert.match(agent.err,/Requesting authentication agent forwarding/);
      assert.match(agent.err,/X11 forwarding request failed/);
    } finally {await new Promise<void>(r=>agentServer.close(()=>r()));}
    // A source IP outside from= cannot authenticate the same otherwise valid key.
    assert.notEqual((await ssh(["chaldea-message-v1"],["-b","127.0.0.2"],JSON.stringify(status))).code,0);
    // Fault-inject a lost receiver receipt AFTER the real T3 acceptance above.
    // Root touches only this ephemeral fixture's idle private DB, never host state.
    const faults=new DatabaseSync(c.database),command=identity("fixture","source",r);
    try {
      faults.prepare("UPDATE receipts SET state='uncertain',result=NULL,payload=? WHERE id=?").run(payload(r,"fixture",command),command.commandId);
      faults.prepare("UPDATE buckets SET tokens=0,observed=? WHERE caller='fixture'").run(Date.now());
      const limited=await ssh(["chaldea-message-v1"],[],JSON.stringify(r));
      assert.equal(limited.code,0,limited.err);assert.equal(JSON.parse(limited.out).state,"uncertain");
      faults.prepare("UPDATE meta SET value=? WHERE name='observed'").run(String(Date.now()+600_000));
      const rollback=await ssh(["chaldea-message-v1"],[],JSON.stringify(r));
      assert.equal(rollback.code,0,rollback.err);assert.equal(JSON.parse(rollback.out).state,"uncertain");
      faults.prepare("UPDATE meta SET value=? WHERE name='observed'").run(String(Date.now()));
      faults.prepare("UPDATE buckets SET tokens=2,observed=? WHERE caller='fixture'").run(Date.now());
      await withClient(opts(),client=>client["orchestration.dispatchCommand"]({
        type:"thread.archive",commandId:"fixture-archive",threadId,
      } as never));
      const archived=await ssh(["chaldea-message-v1"],[],JSON.stringify(r));
      assert.equal(archived.code,0,archived.err);assert.equal(JSON.parse(archived.out).state,"uncertain");
      assert.equal(faults.prepare("SELECT state FROM receipts WHERE id=?").get(command.commandId)!.state,"uncertain");
      const absent=await ssh(["chaldea-message-v1"],[],JSON.stringify({...status,requestId:Date.now()+":absent"}));
      assert.equal(absent.code,0,absent.err);assert.equal(JSON.parse(absent.out).state,"uncertain");
    } finally {faults.close();}
    writeFileSync(config,JSON.stringify({...c,callers:{}}),{mode:0o644});
    assert.notEqual((await ssh(["chaldea-message-v1"],[],JSON.stringify(status))).code,0,"revoked ACL checked on replay");
    writeFileSync(config,JSON.stringify(c),{mode:0o644});
    unlinkSync(c.database);
    const lostState=await ssh(["chaldea-message-v1"],[],JSON.stringify({...r,text:"changed after DB loss"}));
    assert.notEqual(lostState.code,0);assert.equal(existsSync(c.database),false,"missing receipt DB never recreates itself");
    t.diagnostic("shell/original command/subsystem/PTY/TCP/StreamLocal/tunnel/agent/X11/source/env/ACL/lost-DB gates passed");
  }finally{
    for(const client of cleanupClients)client.kill("SIGKILL");
    if(daemon?.pid){daemon.kill("SIGTERM");await new Promise<void>(r=>daemon!.once("close",()=>r()));}
    await watcher?.close();await t3?.stop();
    if(created)run("userdel",[user]);
    rmSync(dir,{recursive:true,force:true});
  }
});
