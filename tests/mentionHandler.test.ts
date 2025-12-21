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
      return { output: { text: 'Hello', blocks: [{ type: 'section', text: { type: 'mrkdwn', text: 'Hello' } }] } };
    },
  };

  const codex: CodexClient = {
    startThread: async () => fakeThread,
    resumeThread: async () => fakeThread,
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
      blockKitOutputSchema: {},
    },
  );

  assert.equal(prompts.length, 1);
  assert.match(prompts[0], /Thread: C1/);
  assert.equal(posted.text, 'Hello');
  assert.equal(Array.isArray(posted.blocks), true);

  const record = store.get('C1:1.0');
  assert.equal(record?.lastResponseTs, '3.0');
  assert.equal(record?.codexThreadId, 'thread-1');
});

test('handleAppMention retries when Slack rejects the response', async () => {
  const store = await makeStore();
  const prompts: string[] = [];
  let runCount = 0;

  const fakeThread: CodexThread = {
    id: 'thread-1',
    run: async (prompt) => {
      runCount += 1;
      prompts.push(prompt);
      if (runCount === 1) {
        return { output: { text: 'First try', blocks: [{ type: 'section', text: { type: 'mrkdwn', text: 'First' } }] } };
      }
      return { output: { text: 'Second try', blocks: [{ type: 'section', text: { type: 'mrkdwn', text: 'Second' } }] } };
    },
  };

  const codex: CodexClient = {
    startThread: async () => fakeThread,
    resumeThread: async () => fakeThread,
  };

  let postedText = '';
  let postCount = 0;
  const client = {
    conversations: {
      replies: async () => ({ messages: [{ ts: '1.0', user: 'U1', text: 'hey' }] }),
    },
    chat: {
      postMessage: async ({ text }: { text: string }) => {
        postCount += 1;
        if (postCount === 1) {
          throw new Error('invalid_blocks');
        }
        postedText = text;
        return { ts: '2.0' };
      },
    },
  };

  const validateBlockKit = (_payload: unknown): BlockKitValidationResult => ({ ok: true });

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
      blockKitOutputSchema: {},
    },
  );

  assert.equal(runCount, 2);
  assert.equal(postCount, 2);
  assert.equal(postedText, 'Second try');
  assert.match(prompts[1], /Slack error: invalid_blocks/);
});
