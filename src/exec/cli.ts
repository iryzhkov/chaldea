import { run } from './client.ts';
try { process.exitCode = await run(process.argv.slice(2)); }
catch (error) { process.stderr.write('chaldea: ' + (error as Error).message + '\n'); process.exitCode = 125; }
