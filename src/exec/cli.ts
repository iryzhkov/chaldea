import { run } from './client.ts';

// Remote statuses pass through; local failures use 255, auto exhaustion uses 69.
try {
  process.exitCode = await run(process.argv.slice(2));
} catch (error) {
  process.stderr.write('chaldea: ' + (error as Error).message + '\n');
  process.exitCode = 255;
}
