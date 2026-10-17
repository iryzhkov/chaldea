// Disposable service child for crash tests; never used by the installed CLI.
import { loadConfig } from "../../src/waits/config.ts";
import { startWaitService } from "../../src/waits/service.ts";
const service=await startWaitService(loadConfig(process.argv[2]),{boundary(name){
  if(name===process.argv[3])process.kill(process.pid,"SIGKILL");
}});
process.stdout.write("ready\n");
await new Promise<void>(resolve=>{process.once("SIGTERM",resolve);process.once("SIGINT",resolve);});
await service.stop();
