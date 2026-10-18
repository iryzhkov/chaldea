import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { execFileSync, spawnSync } from "node:child_process";

test("static login-shell launcher strips hostile environment before any interpreter starts",()=>{
  assert.notEqual(homedir(),"/home/igor");assert.notEqual(homedir(),"/root");
  const root=join(homedir(),"message-launcher-tests");mkdirSync(root,{recursive:true,mode:0o700});
  const dir=mkdtempSync(join(root,"t-"));
  try{
    const marker=join(dir,"injected"),shell=join(dir,"env.sh"),receiver=join(dir,"env.mjs"),binary=join(dir,"launcher");
    writeFileSync(shell,"touch "+marker+"\n");
    writeFileSync(receiver,"console.log(JSON.stringify({env:process.env,args:process.argv.slice(2)}));\n");
    const library=join(dir,"hostile.so"),source=join(dir,"hostile.c");
    writeFileSync(source,'#include <stdio.h>\n__attribute__((constructor)) static void injected(void){FILE *f=fopen('+JSON.stringify(marker)+',"w");if(f)fclose(f);}\n');
    execFileSync("cc",["-shared","-fPIC","-o",library,source]);
    execFileSync("cc",["-static","-O2","-Wall","-Wextra","-Werror","-DMESSAGE_NODE="+JSON.stringify(process.execPath),
      "-DMESSAGE_RECEIVER="+JSON.stringify(receiver),"-DMESSAGE_CONFIG="+JSON.stringify(join(dir,"config")),
      "-o",binary,resolve("host/chaldea-message-launcher.c")]);
    assert.doesNotMatch(execFileSync("readelf",["-l",binary],{encoding:"utf8"}),/INTERP/);
    assert.doesNotMatch(execFileSync("readelf",["-d",binary],{encoding:"utf8"}),/NEEDED/);
    const env={PATH:"/hostile",SSH_ORIGINAL_COMMAND:"chaldea-message-v1",SSH_CONNECTION:"127.0.0.1 1234 127.0.0.1 22",
      NODE_OPTIONS:"--import="+shell,BASH_ENV:shell,ENV:shell,LD_PRELOAD:library,LD_LIBRARY_PATH:dir,SSH_AUTH_SOCK:marker,HOME:dir};
    const forced="/usr/local/libexec/chaldea-message-receive --caller fixture";
    const run=(args:string[])=>spawnSync(binary,args,{env,encoding:"utf8",timeout:5000});
    const good=run(["-c",forced]);assert.equal(good.status,0,good.stderr);
    const result=JSON.parse(good.stdout);
    assert.deepEqual(Object.keys(result.env).sort(),["PATH","SSH_CONNECTION","SSH_ORIGINAL_COMMAND"]);
    assert.equal(result.env.PATH,"/usr/bin:/bin");assert.deepEqual(result.args,[join(dir,"config"),"fixture"]);
    for(const args of [[],["-c","sh"],["-c",forced+"; id"],["-c",forced+" extra"],["-c",forced,"extra"],["-c",forced.replace("fixture","../escape")]])
      assert.notEqual(run(args).status,0);
    assert.equal(existsSync(marker),false,"neither loader nor shell nor Node evaluated hostile env");
  }finally{rmSync(dir,{recursive:true,force:true});}
});
