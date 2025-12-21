import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createBlockKitValidator, buildFallbackMessage } from '../src/blockkit/validator.js';

test('createBlockKitValidator validates payloads', () => {
  const schema = {
    type: 'object',
    required: ['text'],
    properties: {
      text: { type: 'string' },
    },
    additionalProperties: true,
  };

  const { validateBlockKit } = createBlockKitValidator(schema);

  assert.equal(validateBlockKit({ text: 'ok' }).ok, true);
  assert.equal(validateBlockKit({}).ok, false);
});

test('buildFallbackMessage includes summary', () => {
  const msg = buildFallbackMessage('boom');
  assert.match(msg.text, /boom/);
  assert.ok(Array.isArray(msg.blocks));
});

test('openai blockkit schema meets strict requirements', async () => {
  const schemaPath = path.resolve(process.cwd(), 'schemas', 'blockkit-response.openai.schema.json');
  const schema = JSON.parse(await fs.readFile(schemaPath, 'utf8')) as Record<string, unknown>;

  const violations: string[] = [];

  function walk(node: unknown, trail: string[]) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      node.forEach((entry, index) => walk(entry, trail.concat(String(index))));
      return;
    }
    const obj = node as Record<string, unknown>;

    const unsupportedKeys = [
      'oneOf',
      'allOf',
      'not',
      'if',
      'then',
      'else',
      'dependentRequired',
      'dependentSchemas',
      'patternProperties',
      'const',
      'minLength',
      'maxLength',
    ];
    for (const key of unsupportedKeys) {
      if (key in obj) {
        violations.push(`${trail.join('.')} contains unsupported key ${key}`);
      }
    }

    if (obj.properties && typeof obj.properties === 'object' && !Array.isArray(obj.properties)) {
      const propKeys = Object.keys(obj.properties);
      if (!('required' in obj)) {
        violations.push(`${trail.join('.')} missing required`);
      } else if (!Array.isArray(obj.required)) {
        violations.push(`${trail.join('.')} required is not an array`);
      } else {
        const missing = propKeys.filter((key) => !(obj.required as string[]).includes(key));
        if (missing.length > 0) {
          violations.push(`${trail.join('.')} required missing keys: ${missing.join(',')}`);
        }
      }
      if (!('additionalProperties' in obj)) {
        violations.push(`${trail.join('.')} missing additionalProperties`);
      } else if (obj.additionalProperties !== false) {
        violations.push(`${trail.join('.')} additionalProperties must be false`);
      }
      if (obj.type !== 'object') {
        violations.push(`${trail.join('.')} type must be object when properties are present`);
      }
    }

    for (const [key, value] of Object.entries(obj)) {
      walk(value, trail.concat(key));
    }
  }

  walk(schema, []);
  assert.equal(violations.length, 0, `Schema violations:\\n${violations.join('\\n')}`);
});

test('blockkit schema matches select option constraints', async () => {
  const schemaPath = path.resolve(process.cwd(), 'schemas', 'blockkit-response.schema.json');
  const schema = JSON.parse(await fs.readFile(schemaPath, 'utf8')) as Record<string, any>;
  const defs = schema.$defs ?? {};

  const optionObject = defs.optionObject ?? {};
  assert.ok(optionObject.properties, 'optionObject properties missing');
  assert.equal('url' in optionObject.properties, false, 'optionObject should not allow url for select menus');

  const staticSelect = defs.staticSelectElement ?? {};
  assert.ok(staticSelect.properties, 'staticSelectElement properties missing');
  assert.equal('max_selected_items' in staticSelect.properties, false, 'static_select should not allow max_selected_items');
});
