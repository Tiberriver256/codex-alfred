import { readFileSync } from 'node:fs';
import { parseCli, formatHelp } from './config.js';
import { createLogger } from './logger.js';
import { startApp } from './app.js';
import path from 'node:path';

async function main() {
  const { config, showHelp, showVersion } = parseCli(process.argv);

  if (showHelp) {
    process.stdout.write(formatHelp());
    return;
  }

  if (showVersion) {
    const pkgPath = path.resolve(process.cwd(), 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version?: string };
    process.stdout.write(`${pkg.version ?? 'unknown'}\n`);
    return;
  }

  if (!config) return;

  const logger = createLogger(config.logLevel);

  try {
    await startApp(config, logger);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(message);
    process.exitCode = 1;
  }
}

main();
