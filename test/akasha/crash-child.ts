import { readFileSync } from "node:fs";
import { EventStore } from "../../src/akasha/store.ts";
import { hash } from "../../src/akasha/schema.ts";
const [path, mode, time] = process.argv.slice(2);
if (!path || !mode || !time) throw new Error("arguments");
const store = new EventStore(path), event = JSON.parse(readFileSync(0, "utf8"));
if (mode.startsWith("before")) {
  store.transaction = fn => { store.db.exec("BEGIN IMMEDIATE"); fn(); process.kill(process.pid, "SIGKILL"); throw new Error("unreachable"); };
}
if (mode.endsWith("admit")) store.admit(event, hash(event), Number(time));
else store.project(event, 1, Number(time));
process.kill(process.pid, "SIGKILL");
