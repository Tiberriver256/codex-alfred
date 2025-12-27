import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildEmojiSelectorPrompt,
  extractReasoningStatusParts,
  statusSubjectFromPrompt,
  statusEventHint,
} from '../src/slack/codexResponder.js';
import { type CodexThreadEvent } from '../src/codex/client.js';

test('statusSubjectFromPrompt prefers specific subjects over vague request', () => {
  assert.equal(statusSubjectFromPrompt('Pull YNAB transactions from last month'), 'budget');
  assert.equal(statusSubjectFromPrompt('Build a grocery list for dinner'), 'shopping list');
  assert.equal(statusSubjectFromPrompt('Plan a weekend itinerary'), 'plan');
});

test('statusEventHint maps command text to user-friendly intent', () => {
  const event: CodexThreadEvent = {
    type: 'item.completed',
    item: {
      id: 'item-1',
      type: 'command_execution',
      command: "uv run /workspace/scratch/ynab_pending.py --days 60",
      aggregated_output: '',
      exit_code: 0,
      status: 'completed',
    },
  };
  assert.match(statusEventHint(event, 'List pending YNAB transactions'), /budget data/i);
});

test('buildEmojiSelectorPrompt is minimal and text-only', () => {
  const prompt = buildEmojiSelectorPrompt('**Checking pending transactions**');
  assert.match(prompt, /emoji selector/i);
  assert.match(prompt, /NOT a coding agent/i);
  assert.match(prompt, /Return JSON/);
  assert.match(prompt, /<text>/);
  assert.match(prompt, /Checking pending transactions/);
});

test('extractReasoningStatusParts splits heading and details', () => {
  const reasoning =
    '**Summarizing LazyLibrarian overview**\n\n' +
    "I'm putting together a concise summary of LazyLibrarian from its docs.";
  const parts = extractReasoningStatusParts(reasoning);
  assert.equal(parts?.headline, 'Summarizing LazyLibrarian overview');
  assert.equal(parts?.details, "I'm putting together a concise summary of LazyLibrarian from its docs.");
});

test('extractReasoningStatusParts falls back to first line', () => {
  const reasoning = 'Investigating auth issues\nMore details follow.';
  const parts = extractReasoningStatusParts(reasoning);
  assert.equal(parts?.headline, 'Investigating auth issues');
  assert.equal(parts?.details, 'More details follow.');
});
