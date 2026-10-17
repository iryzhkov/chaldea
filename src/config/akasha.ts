import { strictJson } from "../access/token.ts";
import { aliases } from "./compat.ts";
import { configPath } from "./paths.ts";
import { onlyKeys, readJson } from "./files.ts";

export function akashaConfig(path = configPath("akasha")) {
  const c = aliases(readJson(path, false, strictJson), {
    access_state: "accessState", bundle_file: "bundleFile", clock_health_file: "clockHealthFile",
    nats_url: "natsUrl", nats_seed_file: "natsSeedFile",
  });
  onlyKeys(c, ["database", "accessState", "anchors", "bundleFile", "clockHealthFile", "registry", "natsUrl", "natsSeedFile", "bind", "port"]);
  return c;
}
