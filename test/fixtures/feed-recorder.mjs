// Records one JSON line per `feed post` invocation to FEED_RECORDER_LOG:
// the arguments and the body read from stdin. Exits 1 without recording when
// FEED_RECORDER_FAIL_FILE names a file that exists, to simulate a feed outage,
// and records then exits 1 when FEED_RECORDER_FAIL_AFTER_RECORD is 1.
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
// Simulates a server that accepted the post but whose response was lost:
// recorded, then a failure exit with stderr that must never reach logs.
if (process.env.FEED_RECORDER_FAIL_AFTER_RECORD === "1") {
  process.stderr.write("error: someone@example.com https://feed.example/post?token=SECRET-TOKEN-VALUE\n");
  process.exit(1);
}
