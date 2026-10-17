import { WakeStore } from "../../src/wake/store.ts";
const store=new WakeStore(process.argv[2]!,"test-env");
process.stdout.write("owned\n");
await new Promise<void>(resolve=>{process.stdin.resume();process.stdin.once("end",resolve);});
store.close();
