import { test } from 'node:test';
import assert from 'node:assert';
import { stripMarkdown, extractVoiceRequestFromText } from '../src/voice/voiceResponse.js';
import { isAudioFile } from '../src/voice/audioHandler.js';
import { type SlackFile } from '../src/slack/types.js';

test('stripMarkdown removes bold markers', () => {
  const input = 'This is **bold** text';
  const result = stripMarkdown(input);
  assert.strictEqual(result, 'This is bold text');
});

test('stripMarkdown removes italic markers', () => {
  const input = 'This is *italic* text';
  const result = stripMarkdown(input);
  assert.strictEqual(result, 'This is italic text');
});

test('stripMarkdown removes code blocks', () => {
  const input = 'Before ```code here``` after';
  const result = stripMarkdown(input);
  assert.strictEqual(result, 'Before [code block] after');
});

test('stripMarkdown removes links but keeps text', () => {
  const input = 'Check [this link](https://example.com) out';
  const result = stripMarkdown(input);
  assert.strictEqual(result, 'Check this link out');
});

test('stripMarkdown removes headings', () => {
  const input = '## Heading\nContent';
  const result = stripMarkdown(input);
  assert.strictEqual(result, 'Heading\nContent');
});

test('stripMarkdown handles complex markdown', () => {
  const input = '**Status:** OK\n*Next:* run tests\n- Item 1\n- Item 2';
  const result = stripMarkdown(input);
  assert.strictEqual(result, 'Status: OK\nNext: run tests\nItem 1\nItem 2');
});

test('extractVoiceRequestFromText detects voice request keywords', () => {
  const testCases = [
    { input: 'Say it with voice', expected: true },
    { input: 'Give me a voice response', expected: true },
    { input: 'Speak the answer', expected: true },
    { input: 'Just tell me as text', expected: false },
    { input: 'What is the weather?', expected: false },
  ];

  for (const { input, expected } of testCases) {
    const result = extractVoiceRequestFromText(input);
    assert.strictEqual(
      result.requestsVoice,
      expected,
      `Expected "${input}" to ${expected ? 'request' : 'not request'} voice`,
    );
  }
});

test('extractVoiceRequestFromText removes voice keywords from text', () => {
  const input = 'Tell me the weather with voice';
  const result = extractVoiceRequestFromText(input);
  assert.strictEqual(result.requestsVoice, true);
  assert.strictEqual(result.cleanedText, 'Tell me the weather');
});

test('isAudioFile recognizes audio mime types', async () => {
  const audioFile: SlackFile = {
    id: 'F123',
    name: 'audio.mp3',
    mimetype: 'audio/mpeg',
  };

  const result = await isAudioFile(audioFile);
  assert.strictEqual(result, true);
});

test('isAudioFile rejects non-audio mime types', async () => {
  const imageFile: SlackFile = {
    id: 'F124',
    name: 'image.png',
    mimetype: 'image/png',
  };

  const result = await isAudioFile(imageFile);
  assert.strictEqual(result, false);
});

test('isAudioFile handles missing mimetype', async () => {
  const unknownFile: SlackFile = {
    id: 'F125',
    name: 'unknown.bin',
  };

  const result = await isAudioFile(unknownFile);
  assert.strictEqual(result, false);
});

test('isAudioFile recognizes various audio formats', async () => {
  const formats = [
    'audio/mpeg',
    'audio/mp3',
    'audio/wav',
    'audio/wave',
    'audio/ogg',
    'audio/webm',
    'audio/m4a',
  ];

  for (const mimetype of formats) {
    const file: SlackFile = {
      id: 'F126',
      name: 'test',
      mimetype,
    };
    const result = await isAudioFile(file);
    assert.strictEqual(result, true, `Should recognize ${mimetype} as audio`);
  }
});
