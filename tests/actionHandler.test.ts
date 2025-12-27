import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { ThreadStore } from '../src/store/threadStore.js';
import { handleAction } from '../src/slack/actionHandler.js';
import { type AppConfig } from '../src/config.js';
import { type CodexClient, type CodexThread } from '../src/codex/client.js';
import { ThreadWorkManager } from '../src/slack/threadWork.js';

const baseConfig: AppConfig = {
  appToken: 'xapp-test',
  botToken: 'xoxb-test',
  dataDir: '/tmp',
  workDir: '/tmp',
  sandbox: { mode: 'host' },
  codexArgs: [],
  logLevel: 'info',
  mentionBackfill: {
    enabled: true,
    intervalMs: 60000,
    historyLookbackSeconds: 86400,
    maxHistoryPages: 3,
    minAgeSeconds: 60,
  },
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
    run: async (prompt, _options) => {
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
        actions: [{ type: 'button', action_id: 'checklist_yes', value: 'yes' }],
      },
      ack: async () => undefined,
    },
    {
      client,
      store,
      codex,
      work: new ThreadWorkManager(),
      config: baseConfig,
      logger,
      botUserId: 'B1',
      blockKitOutputSchema: {},
    },
  );

  assert.equal(prompts.length, 1);
  assert.match(prompts[0], /Action payload/);
  assert.match(prompts[0], /Form state/);
  assert.doesNotMatch(prompts[0], /Thread:/);
  assert.doesNotMatch(prompts[0], /User:/);
  assert.equal(thinkingText, 'Thinking...');
  assert.equal(posted.text, 'Action ok');
  const record = store.get('C1:1.0');
  assert.equal(record?.codexThreadId, 'thread-2');
});

test('handleAction interrupts active work when cancel button is pressed', async () => {
  const store = await makeStore();
  const work = new ThreadWorkManager();
  const abortController = new AbortController();
  work.begin('C1:1.0', abortController);

  let ran = false;
  const fakeThread: CodexThread = {
    id: 'thread-9',
    run: async (_prompt, _options) => {
      ran = true;
      return { output: { text: 'ok', blocks: [] } };
    },
  };

  const codex: CodexClient = {
    startThread: async () => fakeThread,
    resumeThread: async () => fakeThread,
  };

  const client = {
    conversations: {
      replies: async () => ({ messages: [] }),
    },
    chat: {
      postMessage: async () => ({ ts: '2.0' }),
      update: async () => ({ ts: '3.0' }),
    },
  };

  await handleAction(
    {
      body: {
        user: { id: 'U2' },
        channel: { id: 'C1' },
        message: { ts: '1.0', thread_ts: '1.0', text: 'thinking', blocks: [] },
        actions: [{ type: 'button', action_id: 'interrupt-run' }],
      },
      ack: async () => undefined,
    },
    {
      client,
      store,
      codex,
      work,
      config: baseConfig,
      logger,
      botUserId: 'B1',
      blockKitOutputSchema: {},
    },
  );

  assert.equal(abortController.signal.aborted, true);
  assert.equal(ran, false);
});

test('handleAction ignores non-submit checkbox actions', async () => {
  const store = await makeStore();
  let ran = false;

  const fakeThread: CodexThread = {
    id: 'thread-3',
    run: async (_prompt, _options) => {
      ran = true;
      return { output: { text: 'noop', blocks: [] } };
    },
  };

  const codex: CodexClient = {
    startThread: async () => fakeThread,
    resumeThread: async () => fakeThread,
  };

  const client = {
    conversations: {
      replies: async () => ({ messages: [] }),
    },
    chat: {
      postMessage: async () => ({ ts: '2.0' }),
      update: async () => ({ ts: '3.0' }),
    },
  };

  await handleAction(
    {
      body: {
        user: { id: 'U2' },
        channel: { id: 'C1' },
        message: { ts: '1.0', text: 'checklist', blocks: [] },
        actions: [{ type: 'checkboxes', action_id: 'checklist_items', block_id: 'blk1' }],
        state: {
          values: {
            blk1: {
              checklist_items: {
                type: 'checkboxes',
                selected_options: [
                  { text: { text: 'Task 1' }, value: 'task1' },
                  { text: { text: 'Task 2' }, value: 'task2' },
                ],
              },
            },
          },
        },
      },
      ack: async () => undefined,
    },
    {
      client,
      store,
      codex,
      work: new ThreadWorkManager(),
      config: baseConfig,
      logger,
      botUserId: 'B1',
      blockKitOutputSchema: {},
    },
  );

  assert.equal(ran, false);
});

test('handleAction includes state values for submit actions', async () => {
  const store = await makeStore();
  const prompts: string[] = [];

  const fakeThread: CodexThread = {
    id: 'thread-4',
    run: async (prompt, _options) => {
      prompts.push(prompt);
      return { output: { text: 'ok', blocks: [{ type: 'section', text: { type: 'mrkdwn', text: 'ok' } }] } };
    },
  };

  const codex: CodexClient = {
    startThread: async () => fakeThread,
    resumeThread: async () => fakeThread,
  };

  const client = {
    conversations: {
      replies: async () => ({ messages: [] }),
    },
    chat: {
      postMessage: async () => ({ ts: '2.0' }),
      update: async () => ({ ts: '3.0' }),
    },
  };

  await handleAction(
    {
      body: {
        user: { id: 'U2' },
        channel: { id: 'C1' },
        message: { ts: '1.0', text: 'checklist', blocks: [] },
        actions: [{ type: 'button', action_id: 'submit-checklist', block_id: 'blk2' }],
        state: {
          values: {
            blk1: {
              checklist_items: {
                type: 'checkboxes',
                selected_options: [{ text: { text: 'Task 1' }, value: 'task1' }],
              },
            },
          },
        },
      },
      ack: async () => undefined,
    },
    {
      client,
      store,
      codex,
      work: new ThreadWorkManager(),
      config: baseConfig,
      logger,
      botUserId: 'B1',
      blockKitOutputSchema: {},
    },
  );

  assert.equal(prompts.length, 1);
  assert.match(prompts[0], /selected=\[Task 1\]/);
});
