import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { watch } from "node:fs";
import { parseArgs } from "node:util";
import { discoverServerUrl } from "../t3/adapter.ts";
import { readToken } from "../quota/run.ts";
import { loadState } from "../quota/state.ts";
import { paths } from "../config/paths.ts";
import { MissionModel } from "./model.ts";
import { missionServer } from "./server.ts";
import { runSource } from "./source.ts";
import { fixtureModel } from "./fixture.ts";
export async function missionCli(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({args,options:{ help:{type:"boolean"}, fixture:{type:"boolean"}, port:{type:"string"} },allowPositionals:true,strict:true});
  if(values.help) { process.stdout.write("chaldea mission-control serve [--fixture] [--port 7392]\nRead-only PC canary on 127.0.0.1; no fleet deployment.\n"); return 0; }
  if(positionals.length!==1 || positionals[0]!=="serve") throw new Error("Expected mission-control serve");
  const port=values.port===undefined?7392:Number(values.port);
  if(!Number.isInteger(port)||port<1024||port>65535) throw new Error("Invalid loopback port");
  const model=new MissionModel(values.fixture===true), controller=new AbortController();
  const server=missionServer(model);
  await server.listen(port);
  let watcher: ReturnType<typeof watch> | undefined;
  let debounce: ReturnType<typeof setTimeout> | undefined;
  const statePath=join(paths().state,"quota-observer.json");
  const cached=()=>{ try { model.setQuota(loadState(statePath,Date.now()).headroom); } catch { model.setQuota(null,true); } };
  if(!values.fixture) {
    cached();
    try { watcher=watch(dirname(statePath),(_event,name)=>{ if(name?.toString()==="quota-observer.json") { clearTimeout(debounce); debounce=setTimeout(cached,100); } }); }
    catch { model.setQuota(null,true); }
  } else {
    fixtureModel(model);
  }
  const stop=()=>controller.abort();
  process.once("SIGINT",stop); process.once("SIGTERM",stop);
  process.stdout.write("Mission control: http://127.0.0.1:"+port+"/" + (values.fixture?" · DEMO DATA":"") + "\n");
  const source=values.fixture ? Promise.resolve() : runSource(model,()=>{
    const url=discoverServerUrl(join(homedir(),".t3"));
    if(!url) throw new Error("source_unavailable");
    const parsed=new URL(url);
    if(parsed.protocol!=="http:"||parsed.hostname!=="127.0.0.1"||parsed.username||parsed.password) throw new Error("local_source_required");
    return {serverUrl:url,token:readToken(join(paths().config,"t3-token"))};
  },controller.signal);
  try { await new Promise<void>(resolve=>controller.signal.addEventListener("abort",()=>resolve(),{once:true})); }
  finally { watcher?.close(); clearTimeout(debounce); await source; await server.close(); process.removeListener("SIGINT",stop); process.removeListener("SIGTERM",stop); }
  return 0;
}
