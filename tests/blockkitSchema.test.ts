import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

test('openai slack ui schema keeps section blocks minimal for simple replies', () => {
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

test('openai slack ui schema includes input + actions blocks for forms', () => {
  const schemaPath = path.resolve(process.cwd(), 'schemas', 'blockkit-response.openai.schema.json');
  const raw = fs.readFileSync(schemaPath, 'utf8');
  const schema = JSON.parse(raw) as {
    $defs?: Record<string, { properties?: Record<string, unknown>; required?: string[] }>;
  };

  const inputBlock = schema.$defs?.inputBlock;
  assert.ok(inputBlock, 'inputBlock definition missing');
  const inputRequired = (inputBlock?.required ?? []).slice().sort();
  assert.deepEqual(inputRequired, ['element', 'label', 'type']);

  const actionsBlock = schema.$defs?.actionsBlock;
  assert.ok(actionsBlock, 'actionsBlock definition missing');
  const actionsRequired = (actionsBlock?.required ?? []).slice().sort();
  assert.deepEqual(actionsRequired, ['elements', 'type']);
});

test('openai slack ui schema does not allow button URLs', () => {
  const schemaPath = path.resolve(process.cwd(), 'schemas', 'blockkit-response.openai.schema.json');
  const raw = fs.readFileSync(schemaPath, 'utf8');
  const schema = JSON.parse(raw) as {
    $defs?: Record<string, { properties?: Record<string, unknown> }>;
  };

  const button = schema.$defs?.buttonElement;
  assert.ok(button, 'buttonElement definition missing');
  const props = button?.properties ?? {};
  assert.equal('url' in props, false);
  assert.equal('value' in props, false);
});

test('openai slack ui schema supports checkbox option descriptions', () => {
  const schemaPath = path.resolve(process.cwd(), 'schemas', 'blockkit-response.openai.schema.json');
  const raw = fs.readFileSync(schemaPath, 'utf8');
  const schema = JSON.parse(raw) as {
    $defs?: Record<string, { properties?: Record<string, unknown>; anyOf?: Array<{ properties?: Record<string, unknown> }> }>;
  };

  const optionObject = schema.$defs?.optionObject;
  assert.ok(optionObject, 'optionObject definition missing');

  const variants = optionObject?.anyOf ?? [];
  assert.ok(variants.length >= 2, 'optionObject variants missing');

  const withDescription = variants.find((variant) => 'description' in (variant.properties ?? {}));
  assert.ok(withDescription, 'optionObject missing description variant');

  const text = withDescription?.properties?.text as { $ref?: string } | undefined;
  assert.equal(text?.$ref, '#/$defs/textObject');
});
