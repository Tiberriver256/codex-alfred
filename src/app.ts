import fs from 'node:fs/promises';
import path from 'node:path';
import { App } from '@slack/bolt';
import { type AppConfig } from './config.js';
import { type Logger } from './logger.js';
import { ThreadStore } from './store/threadStore.js';
import { loadBlockKitOutputSchema } from './blockkit/validator.js';
import { createCodexClient } from './codex/client.js';
import { handleAppMention } from './slack/mentionHandler.js';
import { handleAction } from './slack/actionHandler.js';
import { ensureDockerReady } from './sandbox/docker.js';
import { ThreadWorkManager } from './slack/threadWork.js';
import { startMentionBackfillPoller } from './slack/mentionBackfill.js';

export async function startApp(config: AppConfig, logger: Logger): Promise<void> {
  if (config.sandbox.mode === 'docker') {
    ensureDockerReady(config.sandbox.name, logger);
  }

  const version = await loadAppVersion(logger);
  const buildSha = process.env.ALFRED_BUILD_SHA ?? 'unknown';
  const buildTime = process.env.ALFRED_BUILD_TIME ?? 'unknown';
  logger.info('Alfred starting', {
    version,
    buildSha,
    buildTime,
    sandbox: config.sandbox.mode,
    dataDir: config.dataDir,
    workDir: config.workDir,
  });

  const store = new ThreadStore(path.join(config.dataDir, 'threads.json'));
  await store.load();

  const blockKitOutputSchema = await loadBlockKitOutputSchema();

  const codex = await createCodexClient();
  const work = new ThreadWorkManager();

  const app = new App({
    token: config.botToken,
    appToken: config.appToken,
    socketMode: true,
  });

  const auth = await app.client.auth.test();
  const botUserId = auth.user_id;
  if (!botUserId) {
    throw new Error('Unable to determine bot user ID from Slack auth.test.');
  }

  app.event('app_mention', async ({ event, ack, client }) => {
    const safeAck = ack ?? (async () => undefined);
    await handleAppMention(
      { event: event as any, ack: safeAck },
      {
        client: client as any,
        store,
        codex,
        work,
        config,
        logger,
        botUserId,
        blockKitOutputSchema,
      },
    );
  });

  app.action(/.*/, async ({ body, ack, client }) => {
    const safeAck = ack ?? (async () => undefined);
    await handleAction(
      { body: body as any, ack: safeAck },
      {
        client: client as any,
        store,
        codex,
        work,
        config,
        logger,
        botUserId,
        blockKitOutputSchema,
      },
    );
  });

  await app.start();
  if (config.mentionBackfill.enabled) {
    startMentionBackfillPoller(
      {
        client: app.client as any,
        store,
        codex,
        work,
        config,
        logger,
        botUserId,
        blockKitOutputSchema,
      },
      {
        intervalMs: config.mentionBackfill.intervalMs,
        historyLookbackSeconds: config.mentionBackfill.historyLookbackSeconds,
        maxHistoryPages: config.mentionBackfill.maxHistoryPages,
        minAgeSeconds: config.mentionBackfill.minAgeSeconds,
      },
    );
    logger.info('Mention backfill poller started', {
      intervalMs: config.mentionBackfill.intervalMs,
      historyLookbackSeconds: config.mentionBackfill.historyLookbackSeconds,
      maxHistoryPages: config.mentionBackfill.maxHistoryPages,
      minAgeSeconds: config.mentionBackfill.minAgeSeconds,
    });
  }
  logger.info('Alfred is running.');
}

async function loadAppVersion(logger: Logger): Promise<string | null> {
  try {
    const raw = await fs.readFile(path.join(process.cwd(), 'package.json'), 'utf8');
    const parsed = JSON.parse(raw) as { version?: unknown };
    return typeof parsed.version === 'string' ? parsed.version : null;
  } catch (error) {
    logger.warn('Failed to read package version', error);
    return null;
  }
}
