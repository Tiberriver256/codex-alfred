import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const scriptPath = path.join(__dirname, '..', 'alfred-docker.sh');
const script = fs.readFileSync(scriptPath, 'utf8');

test('alfred-docker waits for Alfred to start by default', () => {
  assert.match(script, /wait_for_alfred\(\)/);
  assert.match(script, /ALFRED_WAIT_INTERVAL:-15/);
  assert.match(script, /Alfred is running\./);

  const occurrences = script.split('wait_for_alfred').length - 1;
  assert.ok(occurrences >= 3, 'expected wait_for_alfred definition and call sites');

  const firstStart = script.indexOf('nohup node');
  assert.ok(firstStart >= 0, 'expected nohup node command');
  const firstWait = script.indexOf('wait_for_alfred', firstStart);
  assert.ok(firstWait > firstStart, 'expected wait_for_alfred after first start');

  const secondStart = script.indexOf('nohup node', firstStart + 1);
  assert.ok(secondStart >= 0, 'expected second nohup node command');
  const secondWait = script.indexOf('wait_for_alfred', secondStart);
  assert.ok(secondWait > secondStart, 'expected wait_for_alfred after second start');
});
