import path from 'node:path';
import { App } from '@slack/bolt';
import { type AppConfig } from './config.js';
import { type Logger } from './logger.js';
import { ThreadStore } from './store/threadStore.js';
import { loadBlockKitSchema, createBlockKitValidator } from './blockkit/validator.js';
import { createCodexClient } from './codex/client.js';
import { handleAppMention } from './slack/mentionHandler.js';
import { ensureDockerReady } from './sandbox/docker.js';

export async function startApp(config: AppConfig, logger: Logger): Promise<void> {
  if (config.sandbox.mode === 'docker') {
    ensureDockerReady(config.sandbox.name, logger);
  }

  const store = new ThreadStore(path.join(config.dataDir, 'threads.json'));
  await store.load();

  const blockKitSchema = await loadBlockKitSchema();
  const { validateBlockKit } = createBlockKitValidator(blockKitSchema);

  const codex = await createCodexClient();

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
        config,
        logger,
        botUserId,
        validateBlockKit,
        blockKitSchema,
      },
    );
  });

  await app.start();
  logger.info('Alfred is running.');
}
