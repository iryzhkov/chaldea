// Test process boundary only. Never installed as a production entry point.
import { readFileSync } from "node:fs";
import { tokenHelperCli } from "../../src/access/helper.ts";
const fixture = JSON.parse(readFileSync(process.argv[2]!, "utf8"));
process.exitCode = await tokenHelperCli(process.argv.slice(3), undefined, {
  uid: 995, caller: fixture.caller, config: () => fixture.config,
  key: fixture.key, issuer: "chaldea:agent-a", kid: "agent-a-2026-10",
});
