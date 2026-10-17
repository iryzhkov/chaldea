// E2E-only observer process: SIGKILL immediately after T3 acknowledges the hold.
// Uses the production switcher/state/sink, with no production crash hook.
import { parseArgs } from "node:util";
import { connectShell, switchPort } from "../../src/t3/adapter.ts";
import { readToken, EventSink } from "../../src/quota/run.ts";
import { loadState } from "../../src/quota/state.ts";
import { ProviderSwitcher } from "../../src/quota/switcher.ts";
import { switchConfig } from "../../src/quota/routing.ts";
import { FeedPoster } from "../../src/feed/poster.ts";
import { createLogger } from "../../src/log.ts";
const { values } = parseArgs({ allowPositionals: true, options: {
  "server-url": { type: "string" }, "token-file": { type: "string" }, "state-file": { type: "string" },
  "feed-command": { type: "string" }, "host": { type: "string" }, "enable-provider-switch": { type: "boolean" },
} });
const logger = createLogger();
const connection = { serverUrl: values["server-url"]!, token: readToken(values["token-file"]!) };
const state = loadState(values["state-file"]!, Date.now());
const poster = new FeedPoster({ command: values["feed-command"]!, host: values.host!, logger });
const sink = new EventSink(state, values["state-file"]!, poster, logger);
const port = switchPort(connection), recovery = port.recovery;
port.recovery = async (input) => {
  const accepted = await recovery(input);
  if (accepted && !input.autoResume) process.kill(process.pid, "SIGKILL");
  return accepted;
};
const switcher = new ProviderSwitcher({ state, port, config: switchConfig({ enabled: true }), logger,
  save: () => { sink.save(); return !sink.dirty; }, record: (record) => sink.record([record]) });
await connectShell(connection, { onEvent: async (event) => {
  logger.info("subscribed to T3 shell");
  await switcher.handle(event); sink.handle(event);
} });
