import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { resolveAttachments } from '../src/slack/attachmentResolver.js';

test('resolveAttachments uses docker copy for non-workspace paths in docker mode', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'alfred-data-'));
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'alfred-work-'));

  let dockerCall: { container: string; source: string; dest: string } | null = null;
  const dockerCopy = (container: string, source: string, dest: string) => {
    dockerCall = { container, source, dest };
    fsSync.writeFileSync(dest, 'copied');
  };

  const { resolved, failures, cleanup } = await resolveAttachments(
    [{ path: '/tmp/report.txt' }],
    { workDir, dataDir, sandbox: { mode: 'docker', name: 'sandbox-1' } },
    { dockerCopy },
  );

  assert.equal(failures.length, 0);
  assert.equal(resolved.length, 1);
  assert.ok(resolved[0].path.startsWith(path.join(os.tmpdir(), 'alfred-attachments')));
  assert.equal(fsSync.readFileSync(resolved[0].path, 'utf8'), 'copied');
  assert.deepEqual(dockerCall, {
    container: 'sandbox-1',
    source: '/tmp/report.txt',
    dest: resolved[0].path,
  });
  assert.equal(cleanup.length, 1);
});
