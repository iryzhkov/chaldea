// Disposable child: simulate process death between accepted dispatch and journal acknowledgement.
import { RestartJournal, recoverPlannedRestarts, restartConfig } from "../../src/t3/restart.ts";
import { createLogger } from "../../src/log.ts";
const [journalPath, t3BaseDir, tokenFile, crashAt = "resumed"] = process.argv.slice(2);
const journal = new RestartJournal(journalPath!);
const phase = journal.phase.bind(journal);
journal.phase = (base, intent, next) => {
  if (next === crashAt) process.exit(73);
  phase(base, intent, next);
};
await recoverPlannedRestarts({ t3BaseDir: t3BaseDir!, tokenFile: tokenFile!,
  config: { ...restartConfig(), journalPath: journalPath! }, logger: createLogger(() => {}) },
  journal, { enqueue() { throw new Error("should crash before feed"); } });
process.exit(74);
