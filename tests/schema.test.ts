import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

test('openai blockkit schema attachment requires all properties', async () => {
  const schemaPath = path.join(process.cwd(), 'schemas', 'blockkit-response.openai.schema.json');
  const raw = await fs.readFile(schemaPath, 'utf8');
  const schema = JSON.parse(raw) as {
    $defs?: Record<string, { properties?: Record<string, unknown>; required?: string[] }>;
  };

  const attachment = schema.$defs?.attachment;
  assert.ok(attachment, 'attachment schema exists');

  const properties = Object.keys(attachment?.properties ?? {});
  const required = attachment?.required ?? [];

  assert.deepEqual(required.sort(), properties.sort());
});
