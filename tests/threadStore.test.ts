import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { ThreadStore } from '../src/store/threadStore.js';

async function withTempDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'alfred-'));
  return dir;
}

test('ThreadStore persists and reloads records', async () => {
  const dir = await withTempDir();
  const filePath = path.join(dir, 'threads.json');
  const store = new ThreadStore(filePath);

  await store.load();
  await store.set({ threadKey: 'C1:1', codexThreadId: 't1', lastResponseTs: '1.0' });

  const store2 = new ThreadStore(filePath);
  await store2.load();

  const record = store2.get('C1:1');
  assert.equal(record?.codexThreadId, 't1');
  assert.equal(record?.lastResponseTs, '1.0');

  await store2.update('C1:1', { lastResponseTs: '2.0' });
  const updated = store2.get('C1:1');
  assert.equal(updated?.lastResponseTs, '2.0');
});

test('ThreadStore handles corrupt data by resetting', async () => {
  const dir = await withTempDir();
  const filePath = path.join(dir, 'threads.json');
  await fs.writeFile(filePath, '{not valid json}', 'utf8');

  const store = new ThreadStore(filePath);
  await store.load();

  assert.equal(store.get('missing'), undefined);
});
