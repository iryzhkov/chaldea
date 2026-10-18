// Bundled only into the ephemeral SSH fixture. Check the native launcher boundary.
import { appendFileSync } from "node:fs";
const allowed=["PATH","SSH_CONNECTION","SSH_ORIGINAL_COMMAND"];
if(Object.keys(process.env).some(key=>!allowed.includes(key)))process.exit(90);
if(process.env.PATH!=="/usr/bin:/bin")process.exit(91);
appendFileSync(process.argv[2]+".env-checked","clean\n",{mode:0o600});
// The bundled production entry guard starts the receiver once. Check env first.
await import("../../src/message-receiver.ts");
