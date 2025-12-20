import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { ThreadStore } from '../src/store/threadStore.js';
import { handleAppMention } from '../src/slack/mentionHandler.js';
import { type BlockKitValidationResult } from '../src/blockkit/validator.js';
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

test('handleAppMention posts response and updates store', async () => {
  const store = await makeStore();
  const prompts: string[] = [];

  const fakeThread: CodexThread = {
    id: 'thread-1',
    run: async (prompt) => {
      prompts.push(prompt);
      return { output: { text: 'Hello', blocks: [] } };
    },
  };

  const codex: CodexClient = {
    startThread: async () => fakeThread,
    getThread: async () => fakeThread,
  };

  const posted: { text?: string; blocks?: unknown[] } = {};
  const client = {
    conversations: {
      replies: async () => ({
        messages: [
          { ts: '1.0', user: 'U1', text: '<@B1> hello' },
          { ts: '2.0', user: 'U2', text: 'follow up' },
        ],
      }),
    },
    chat: {
      postMessage: async ({ text, blocks }: { text: string; blocks: unknown[] }) => {
        posted.text = text;
        posted.blocks = blocks;
        return { ts: '3.0' };
      },
    },
  };

  const validateBlockKit = (_payload: unknown): BlockKitValidationResult => ({ ok: true });

  await handleAppMention(
    {
      event: { channel: 'C1', ts: '1.0', text: '<@B1> hello' },
      ack: async () => undefined,
    },
    {
      client,
      store,
      codex,
      config: baseConfig,
      logger,
      botUserId: 'B1',
      validateBlockKit,
      blockKitSchema: {},
    },
  );

  assert.equal(prompts.length, 1);
  assert.match(prompts[0], /Thread: C1/);
  assert.equal(posted.text, 'Hello');

  const record = store.get('C1:1.0');
  assert.equal(record?.lastResponseTs, '3.0');
});

test('handleAppMention falls back on invalid block kit', async () => {
  const store = await makeStore();

  const fakeThread: CodexThread = {
    id: 'thread-1',
    run: async () => ({ output: { text: 'Bad', blocks: [] } }),
  };

  const codex: CodexClient = {
    startThread: async () => fakeThread,
    getThread: async () => fakeThread,
  };

  let postedText = '';
  const client = {
    conversations: {
      replies: async () => ({ messages: [{ ts: '1.0', user: 'U1', text: 'hey' }] }),
    },
    chat: {
      postMessage: async ({ text }: { text: string }) => {
        postedText = text;
        return { ts: '2.0' };
      },
    },
  };

  const validateBlockKit = (_payload: unknown): BlockKitValidationResult => ({ ok: false, errors: ['bad'] });

  await handleAppMention(
    { event: { channel: 'C2', ts: '1.0', text: 'hey' }, ack: async () => undefined },
    {
      client,
      store,
      codex,
      config: baseConfig,
      logger,
      botUserId: 'B1',
      validateBlockKit,
      blockKitSchema: {},
    },
  );

  assert.match(postedText, /Alfred error/);
});
