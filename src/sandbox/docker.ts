import { execSync } from 'node:child_process';
import { type Logger } from '../logger.js';

export function ensureDockerReady(containerName: string, logger: Logger): void {
  try {
    execSync('docker --version', { stdio: 'ignore' });
  } catch {
    throw new Error('Docker is not available. Install Docker and ensure `docker --version` works.');
  }

  try {
    const running = execSync(`docker inspect -f '{{.State.Running}}' ${containerName}`, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();

    if (running !== 'true') {
      throw new Error('not running');
    }
  } catch {
    logger.error(`Docker container "${containerName}" is not running.`);
    logger.error(`Start it with: docker start ${containerName}`);
    logger.error('Or create it with: ./docker.sh create <data-dir>');
    throw new Error('Docker sandbox is unavailable.');
  }
}
