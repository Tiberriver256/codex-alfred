import { test } from 'node:test';
import assert from 'node:assert/strict';
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
