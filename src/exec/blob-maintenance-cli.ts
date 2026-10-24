import { operatorMain } from './blob-maintenance.ts';
try { await operatorMain(process.argv.slice(3)); }
catch {
  process.stderr.write('Blob maintenance failed. Keep publication paused. Preserve original job IDs, local copies, journals, and all backup pairs. Inspect the trusted local configuration and service; no automatic retry.\n');
  process.exitCode = 2;
}
