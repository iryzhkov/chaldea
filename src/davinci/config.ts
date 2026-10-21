import { lstatSync } from "node:fs";
import { dirname } from "node:path";
import { readJson } from "../config/files.ts";
import { object, path, field, name, thread, requireMessage as check } from "../message.ts";
import { brokerConfig, mapping, type BrokerConfig, type Mapping } from "../message-broker.ts";
import { definition, binding, type Definition } from "./protocol.ts";
export interface Config {
  role: "coordinator" | "worker"; database: string; logFile: string;
  definition: Definition; broker: BrokerConfig; mapping: Mapping;
  port?: number; keys?: Record<string,string>; socket?: string; caller?: string; policy?: string;
}
export function load(file: string): Config {
  path(file);
  for(let dir=dirname(file);;dir=dirname(dir)) {
    const s=lstatSync(dir);check(s.isDirectory() && !s.isSymbolicLink() && s.uid===0 && (s.mode&0o022)===0,"davinci_config_ancestor");
    if(dir===dirname(dir))break;
  }
  const c=object(readJson(file,false,undefined,{owners:[0],private:true,maxBytes:16384}),
    ["role","database","logFile","definition","broker","mapping","port","keys","socket","caller","policy"]);
  check(c.role==="coordinator" || c.role==="worker","davinci_role");
  const result:Config={role:c.role,database:path(c.database),logFile:path(c.logFile),definition:definition(c.definition),
    broker:brokerConfig(c.broker,"_INBOX_davinci"),mapping:mapping(object(c.mapping),"chaldea.davinci.assignment","chaldea.davinci.result")};
  // Placement must be in its own isolated account, never the existing-thread messaging account.
  check(result.broker.account==="DAVINCI","davinci_account");
  if(c.role==="coordinator") {
    check(Number.isSafeInteger(c.port) && Number(c.port)>=1024 && Number(c.port)<=65535 &&
      c.socket===undefined && c.caller===undefined && c.policy===undefined,"davinci_coordinator_config");
    const keys=object(c.keys);check(Object.keys(keys).length>=1 && Object.keys(keys).length<=2,"davinci_keys");
    result.keys=Object.fromEntries(Object.entries(keys).map(([k,v])=>[name(k),path(v)]));
    check(Object.keys(keys).every(k=>/^[A-Za-z0-9_-]{1,32}$/.test(k)),"davinci_key_id");
    result.port=Number(c.port);
  } else {
    check(c.port===undefined && c.keys===undefined,"davinci_worker_config");
    result.socket=path(c.socket);result.caller=thread(c.caller);result.policy=path(c.policy);
  }
  return result;
}
/** Live edits may disable intake or rotate key files, not change committed authority. */
export function same(original: Config,current: Config): void {
  const stable=(c:Config)=>JSON.stringify({...c,definition:binding(c.definition),keys:null});
  check(stable(original)===stable(current),"davinci_configuration_changed");
}
