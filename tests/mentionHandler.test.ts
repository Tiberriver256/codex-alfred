import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { ThreadStore } from '../src/store/threadStore.js';
import { handleAppMention } from '../src/slack/mentionHandler.js';
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
  let thinkingText = '';
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
      blockKitOutputSchema: {},
    },
  );

  assert.equal(prompts.length, 1);
  assert.match(prompts[0], /Conversations in Block Kit/);
  assert.match(prompts[0], /Mode 1: Conversation/);
  assert.doesNotMatch(prompts[0], /Thread:/);
  assert.doesNotMatch(prompts[0], /User:/);
  assert.equal(thinkingText, 'Thinking...');
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
  let thinkingText = '';
  const client = {
    conversations: {
      replies: async () => ({ messages: [{ ts: '1.0', user: 'U1', text: 'hey' }] }),
    },
    chat: {
      postMessage: async ({ text }: { text: string }) => {
        thinkingText = text;
        return { ts: '2.0' };
      },
      update: async ({ text }: { text: string }) => {
        postCount += 1;
        if (postCount === 1) {
          throw new Error('invalid_blocks');
        }
        postedText = text;
        return { ts: '2.0' };
      },
    },
  };

  await handleAppMention(
    { event: { channel: 'C2', ts: '1.0', text: 'hey' }, ack: async () => undefined },
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

  assert.equal(runCount, 2);
  assert.equal(thinkingText, 'Thinking...');
  assert.ok(postCount >= 2);
  assert.equal(postedText, 'Second try');
  assert.match(prompts[1], /Slack error: invalid_blocks/);
});

test('handleAppMention only injects guidance on first turn', async () => {
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
      postMessage: async () => ({ ts: '2.0' }),
      update: async () => ({ ts: '3.0' }),
    },
  };

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
      blockKitOutputSchema: {},
    },
  );

  await handleAppMention(
    {
      event: { channel: 'C1', ts: '1.0', text: '<@B1> hello again' },
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

  assert.equal(prompts.length, 2);
  assert.match(prompts[0], /Conversations in Block Kit/);
  assert.doesNotMatch(prompts[1], /Conversations in Block Kit/);
});

test('handleAppMention uploads attachments returned by the model', async () => {
  const store = await makeStore();
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'alfred-work-'));
  const readmePath = path.join(workDir, 'README.md');
  await fs.writeFile(readmePath, 'hello');

  const fakeThread: CodexThread = {
    id: 'thread-2',
    run: async () => ({
      output: {
        text: 'Attached.',
        blocks: [{ type: 'section', text: { type: 'mrkdwn', text: 'Attached.' } }],
        attachments: [{ path: 'README.md' }],
      },
    }),
  };

  const codex: CodexClient = {
    startThread: async () => fakeThread,
    resumeThread: async () => fakeThread,
  };

  const uploads: any[] = [];
  const client = {
    conversations: {
      replies: async () => ({
        messages: [{ ts: '1.0', user: 'U1', text: 'Please attach readme.md' }],
      }),
    },
    chat: {
      postMessage: async () => ({ ts: '1.0' }),
      update: async () => ({ ts: '2.0' }),
    },
    files: {
      upload: async (args: any) => {
        uploads.push(args);
        return { file: { id: 'F1' } };
      },
    },
  };

  await handleAppMention(
    {
      event: { channel: 'C1', ts: '1.0', text: 'Please attach readme.md' },
      ack: async () => undefined,
    },
    {
      client,
      store,
      codex,
      config: { ...baseConfig, workDir },
      logger,
      botUserId: 'B1',
      blockKitOutputSchema: {},
    },
  );

  assert.equal(uploads.length, 1);
  assert.equal(uploads[0].channels, 'C1');
  assert.equal(uploads[0].thread_ts, '1.0');
  assert.equal(uploads[0].filename, 'README.md');
});

test('handleAppMention stages temp attachments outside the workspace', async () => {
  const store = await makeStore();
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'alfred-work-'));
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'alfred-data-'));
  const externalDir = await fs.mkdtemp(path.join(os.tmpdir(), 'alfred-external-'));
  const externalPath = path.join(externalDir, 'report.txt');
  await fs.writeFile(externalPath, 'report');

  const fakeThread: CodexThread = {
    id: 'thread-5',
    run: async () => ({
      output: {
        text: 'Attached.',
        blocks: [{ type: 'section', text: { type: 'mrkdwn', text: 'Attached.' } }],
        attachments: [{ path: externalPath }],
      },
    }),
  };

  const codex: CodexClient = {
    startThread: async () => fakeThread,
    resumeThread: async () => fakeThread,
  };

  const uploads: any[] = [];
  const client = {
    conversations: {
      replies: async () => ({
        messages: [{ ts: '1.0', user: 'U1', text: 'Attach the report' }],
      }),
    },
    chat: {
      postMessage: async () => ({ ts: '1.0' }),
      update: async () => ({ ts: '2.0' }),
    },
    files: {
      upload: async (args: any) => {
        uploads.push(args);
        return { file: { id: 'F4' } };
      },
    },
  };

  await handleAppMention(
    {
      event: { channel: 'C1', ts: '1.0', text: 'Attach the report' },
      ack: async () => undefined,
    },
    {
      client,
      store,
      codex,
      config: { ...baseConfig, workDir, dataDir },
      logger,
      botUserId: 'B1',
      blockKitOutputSchema: {},
    },
  );

  assert.equal(uploads.length, 1);
  const stagedDir = path.join(dataDir, 'attachments');
  const stagedFiles = await fs.readdir(stagedDir).catch(() => []);
  assert.equal(stagedFiles.some((name) => name.startsWith('report')), false);
});

test('handleAppMention includes checklist guidance in the intro prompt', async () => {
  const store = await makeStore();
  const prompts: string[] = [];

  const fakeThread: CodexThread = {
    id: 'thread-1',
    run: async (prompt) => {
      prompts.push(prompt);
      return { output: { text: 'Checklist', blocks: [{ type: 'section', text: { type: 'mrkdwn', text: 'Checklist' } }] } };
    },
  };

  const codex: CodexClient = {
    startThread: async () => fakeThread,
    resumeThread: async () => fakeThread,
  };

  const client = {
    conversations: {
      replies: async () => ({
        messages: [{ ts: '1.0', user: 'U1', text: '<@B1> hello' }],
      }),
    },
    chat: {
      postMessage: async () => ({ ts: '2.0' }),
      update: async () => ({ ts: '3.0' }),
    },
  };

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
      blockKitOutputSchema: {},
    },
  );

  assert.equal(prompts.length, 1);
  assert.match(prompts[0], /tracking-only checklists/i);
  assert.doesNotMatch(prompts[0], /Checklist request:/);
});
