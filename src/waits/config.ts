import { ConfigurationError, readJson } from "../config/files.ts";
import { configPath, paths } from "../config/paths.ts";
export { privateFile } from "../config/files.ts";
import { homedir } from "node:os";
import { join } from "node:path";
import { object, text } from "./types.ts";
export interface WaitConfig {
  environment: string; t3BaseDir: string; serverUrl?: string; tokenFile: string;
  database: string; socket: string; listenAddress: string; port: number; answerBaseUrl: string;
  answerTokenFile: string; logFile: string;
}
export const defaultConfigPath = () => configPath("waits");
export function loadConfig(path=defaultConfigPath()): WaitConfig {
  try { return parseConfig(path); }
  catch (error) {
    if (error instanceof ConfigurationError) throw error;
    throw new ConfigurationError("Invalid waits configuration", path, "schema");
  }
}
function parseConfig(path: string): WaitConfig {
  const v=object(readJson(path));
  const home=homedir(), p=paths();
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
    tokenFile:local("tokenFile",join(p.config,"waits-t3-token")),
    database:local("database",join(p.state,"waits.sqlite")),
    socket:local("socket",join(p.runtime,"chaldea-waits.sock")),
    listenAddress:local("listenAddress","127.0.0.1"),port:Number(port),answerBaseUrl,
    answerTokenFile:local("answerTokenFile",join(p.config,"waits-answer-token")),
    logFile:local("logFile",join(p.state,"waits.log"))};
}
