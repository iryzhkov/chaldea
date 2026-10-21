import { configFailure, ConfigurationError } from '../config/files.ts';
import { EXIT } from '../config/exit.ts';
import { createLogger } from '../config/log.ts';
import { run } from './client.ts';

// Remote statuses pass through; local failures use 255, auto exhaustion uses 69.
try {
  if (process.argv.length === 4 && ["--help", "-h"].includes(process.argv[3]!)) {
    process.stdout.write("Usage: chaldea exec [--host H] [--queue-timeout 1h] [--no-queue] [--artifact PATH] [--gpu] -- CMD...\n" +
      "       chaldea exec list | show JOB-ID [--full] | fetch JOB-ID\n" +
      "       chaldea exec artifacts publish JOB-ID | artifacts fetch JOB-ID --output NEW-DIRECTORY\n");
  } else process.exitCode = await run(process.argv.slice(2));
} catch (error) {
  createLogger().error('exec failed', { ...configFailure(error), error: (error as Error).message });
  process.exitCode = error instanceof ConfigurationError ? EXIT.config : EXIT.transport;
}
