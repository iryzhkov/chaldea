import { readFileSync, openSync, fstatSync, closeSync, constants } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { object, text } from "./types.ts";
export interface WaitConfig {
  environment: string; t3BaseDir: string; serverUrl?: string; tokenFile: string;
  database: string; socket: string; listenAddress: string; port: number; answerBaseUrl: string;
  answerTokenFile: string; logFile: string;
}
export const defaultConfigPath=() => join(homedir(),".config/chaldea/waits.json");
/** Open with NOFOLLOW and inspect the opened descriptor; never print secret bytes or argv. */
export function privateFile(path: string): string {
  const fd=openSync(path,constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const s=fstatSync(fd);
    if (!s.isFile() || s.uid !== process.getuid?.() || (s.mode & 0o777) !== 0o600 || s.size > 16*1024)
      throw new Error("Credential file requires owner uid, mode 0600 and <=16 KiB");
    const value=readFileSync(fd,"utf8").trim();
    if (!value) throw new Error("Empty credential file"); return value;
  } finally {closeSync(fd);}
}
export function loadConfig(path=defaultConfigPath()): WaitConfig {
  const v=object(JSON.parse(readFileSync(path,"utf8")));
  const home=homedir();
  const local=(name:string, fallback:string) => v[name] === undefined ? fallback : text(v[name],name,4096);
  const port=v.port??7385;
  if (!Number.isInteger(port) || Number(port)<0 || Number(port)>65535) throw new Error("Invalid port");
  const answerBaseUrl=local("answerBaseUrl","http://127.0.0.1:" + port);
  for (const value of [answerBaseUrl,v.serverUrl]) if (value !== undefined) {
    const url=new URL(String(value));
    if (!["http:","https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error("Invalid service URL");
  }
  return {environment:text(v.environment,"environment"),t3BaseDir:local("t3BaseDir",join(home,".t3")),
    ...(v.serverUrl === undefined ? {} : {serverUrl:text(v.serverUrl,"serverUrl",4096)}),
    tokenFile:local("tokenFile",join(home,".config/chaldea/waits-t3-token")),
    database:local("database",join(home,".local/state/chaldea/waits.sqlite")),
    socket:local("socket",join(process.env.XDG_RUNTIME_DIR??join(home,".cache"),"chaldea-waits.sock")),
    listenAddress:local("listenAddress","127.0.0.1"),port:Number(port),answerBaseUrl,
    answerTokenFile:local("answerTokenFile",join(home,".config/chaldea/waits-answer-token")),
    logFile:local("logFile",join(home,".local/state/chaldea/waits.log"))};
}
