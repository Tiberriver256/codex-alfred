import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildStatusSummaryPrompt,
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

test('buildStatusSummaryPrompt asks for why and avoids vague phrasing', () => {
  const prompt = buildStatusSummaryPrompt({
    userPrompt: 'List pending YNAB transactions',
    eventType: 'item.completed',
    recentEvents: [],
    currentEvent: { type: 'turn.started' },
    subject: 'budget',
    eventHint: 'checking budget data',
  });
  assert.match(prompt, /why/i);
  assert.match(prompt, /avoid vague phrasing/i);
  assert.doesNotMatch(prompt, /Your request/);
});
