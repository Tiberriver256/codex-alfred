import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

test('openai blockkit schema keeps section blocks minimal for simple replies', () => {
  const schemaPath = path.resolve(process.cwd(), 'schemas', 'blockkit-response.openai.schema.json');
  const raw = fs.readFileSync(schemaPath, 'utf8');
  const schema = JSON.parse(raw) as {
    $defs?: Record<string, { properties?: Record<string, unknown>; required?: string[] }>;
  };

  const section = schema.$defs?.sectionBlock;
  assert.ok(section, 'sectionBlock definition missing');

  const props = section?.properties ?? {};
  assert.equal('fields' in props, false);
  assert.equal('accessory' in props, false);

  const required = (section?.required ?? []).slice().sort();
  assert.deepEqual(required, ['text', 'type']);
});
