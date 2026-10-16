// Records one JSON line per `feed post` invocation to FEED_RECORDER_LOG:
// the arguments and the body read from stdin. Exits 1 without recording when
// FEED_RECORDER_FAIL_FILE names a file that exists, to simulate a feed outage.
import { appendFileSync, existsSync } from "node:fs";

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const failFile = process.env.FEED_RECORDER_FAIL_FILE;
if (failFile && existsSync(failFile)) {
  process.stderr.write("feed: simulated outage\n");
  process.exit(1);
}
const log = process.env.FEED_RECORDER_LOG;
if (!log) {
  process.stderr.write("FEED_RECORDER_LOG is not set\n");
  process.exit(2);
}
appendFileSync(log, `${JSON.stringify({ args: process.argv.slice(2), body: Buffer.concat(chunks).toString("utf8") })}\n`);
