import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { ThreadStore } from '../src/store/threadStore.js';
import { collectMissedMentions } from '../src/slack/mentionBackfill.js';

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

test('collectMissedMentions finds mentions in thread replies after downtime', async () => {
  const store = await makeStore();
  const client = {
    conversations: {
      list: async () => ({
        channels: [{ id: 'C1', is_member: true }],
        response_metadata: {},
      }),
      history: async () => ({
        messages: [
          { ts: '50.0', user: 'U2', text: 'root', reply_count: 1, latest_reply: '150.0' },
        ],
        response_metadata: {},
      }),
      replies: async () => ({
        messages: [
          { ts: '150.0', thread_ts: '50.0', user: 'U1', text: '<@B1> help' },
        ],
      }),
    },
    chat: {
      postMessage: async () => ({ ts: '1' }),
      update: async () => ({ ts: '1' }),
    },
  };

  const state = { lastPollTs: '100.0' };
  const mentions = await collectMissedMentions(
    { client, store, logger, botUserId: 'B1' },
    state,
    { historyLookbackSeconds: 3600, maxHistoryPages: 1, minAgeSeconds: 0, now: () => 200 },
  );

  assert.equal(mentions.length, 1);
  assert.deepEqual(mentions[0], {
    channel: 'C1',
    ts: '150.0',
    thread_ts: '50.0',
    text: '<@B1> help',
    user: 'U1',
  });
  assert.equal(state.lastPollTs, '200');
});

test('collectMissedMentions delays handling until mentions are older than min age', async () => {
  const store = await makeStore();
  const client = {
    conversations: {
      list: async () => ({
        channels: [{ id: 'C1', is_member: true }],
        response_metadata: {},
      }),
      history: async () => ({
        messages: [
          { ts: '50.0', user: 'U2', text: 'root', reply_count: 1, latest_reply: '150.0' },
        ],
        response_metadata: {},
      }),
      replies: async () => ({
        messages: [
          { ts: '150.0', thread_ts: '50.0', user: 'U1', text: '<@B1> help' },
        ],
      }),
    },
    chat: {
      postMessage: async () => ({ ts: '1' }),
      update: async () => ({ ts: '1' }),
    },
  };

  const state = { lastPollTs: '100.0' };
  const first = await collectMissedMentions(
    { client, store, logger, botUserId: 'B1' },
    state,
    { historyLookbackSeconds: 3600, maxHistoryPages: 1, minAgeSeconds: 60, now: () => 200 },
  );

  assert.equal(first.length, 0);
  assert.equal(state.lastPollTs, '140');

  const second = await collectMissedMentions(
    { client, store, logger, botUserId: 'B1' },
    state,
    { historyLookbackSeconds: 3600, maxHistoryPages: 1, minAgeSeconds: 60, now: () => 260 },
  );

  assert.equal(second.length, 1);
  assert.equal(second[0]?.ts, '150.0');
  assert.equal(state.lastPollTs, '200');
});
