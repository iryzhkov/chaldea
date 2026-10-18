// Bundled only into the ephemeral SSH fixture. Check the native launcher boundary.
import { appendFileSync } from "node:fs";
import { receiverMain } from "../../src/message-receiver.ts";
const allowed=["PATH","SSH_CONNECTION","SSH_ORIGINAL_COMMAND"];
if(Object.keys(process.env).some(key=>!allowed.includes(key)))process.exit(90);
if(process.env.PATH!=="/usr/bin:/bin")process.exit(91);
appendFileSync(process.argv[2]+".env-checked","clean\n",{mode:0o600});
const timer=setTimeout(()=>process.exit(1),20_000);
try{process.exitCode=await receiverMain(process.argv.slice(2));}catch{process.exitCode=1;}
finally{clearTimeout(timer);}
