import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { ThreadStore } from '../src/store/threadStore.js';
import { handleAction } from '../src/slack/actionHandler.js';
import { type AppConfig } from '../src/config.js';
import { type CodexClient, type CodexThread } from '../src/codex/client.js';

const baseConfig: AppConfig = {
  appToken: 'xapp-test',
  botToken: 'xoxb-test',
  dataDir: '/tmp',
  workDir: '/tmp',
  sandbox: { mode: 'host' },
  codexArgs: [],
  logLevel: 'info',
};

const logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

async function makeStore() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'alfred-'));
  const store = new ThreadStore(path.join(dir, 'threads.json'));
  await store.load();
  return store;
}

test('handleAction posts response and updates store', async () => {
  const store = await makeStore();
  const prompts: string[] = [];

  const fakeThread: CodexThread = {
    id: 'thread-2',
    run: async (prompt) => {
      prompts.push(prompt);
      return {
        output: {
          text: 'Action ok',
          blocks: [{ type: 'section', text: { type: 'mrkdwn', text: 'Action ok' } }],
        },
      };
    },
  };

  const codex: CodexClient = {
    startThread: async () => fakeThread,
    resumeThread: async () => fakeThread,
  };

  const posted: { text?: string; blocks?: unknown[] } = {};
  let thinkingText = '';
  const client = {
    conversations: {
      replies: async () => ({ messages: [{ ts: '1.0', user: 'U1', text: 'hello' }] }),
    },
    chat: {
      postMessage: async ({ text, blocks }: { text: string; blocks: unknown[] }) => {
        thinkingText = text;
        return { ts: '2.0' };
      },
      update: async ({ text, blocks }: { text: string; blocks: unknown[] }) => {
        posted.text = text;
        posted.blocks = blocks;
        return { ts: '3.0' };
      },
    },
  };

  await handleAction(
    {
      body: {
        user: { id: 'U2' },
        channel: { id: 'C1' },
        message: { ts: '1.0', text: 'checklist', blocks: [] },
        actions: [{ action_id: 'checklist_yes', value: 'yes' }],
      },
      ack: async () => undefined,
    },
    {
      client,
      store,
      codex,
      config: baseConfig,
      logger,
      botUserId: 'B1',
      blockKitOutputSchema: {},
    },
  );

  assert.equal(prompts.length, 1);
  assert.match(prompts[0], /Action payload/);
  assert.doesNotMatch(prompts[0], /Thread:/);
  assert.doesNotMatch(prompts[0], /User:/);
  assert.equal(thinkingText, 'Thinking...');
  assert.equal(posted.text, 'Action ok');
  const record = store.get('C1:1.0');
  assert.equal(record?.codexThreadId, 'thread-2');
});
