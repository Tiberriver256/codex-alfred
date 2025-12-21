import { extractStructuredOutput, type CodexThread } from '../codex/client.js';
import { type BlockKitMessage } from '../blockkit/validator.js';
import { type Logger } from '../logger.js';
import { type SlackClientLike } from './types.js';

export async function runCodexAndPost(params: {
  thread: CodexThread;
  prompt: string;
  outputSchema: object;
  logger: Logger;
  threadKey: string;
  client: SlackClientLike;
  channel: string;
  threadTs: string;
}): Promise<{ response: { ts?: string }; output: BlockKitMessage }> {
  const { thread, prompt, outputSchema, logger, threadKey, client, channel, threadTs } = params;
  let lastError: string | null = null;
  let lastOutput: unknown = null;
  const thinking = await client.chat.postMessage({
    channel,
    thread_ts: threadTs,
    text: 'Thinking...',
    blocks: [
      {
        type: 'section',
        text: { type: 'mrkdwn', text: '_Thinking..._' },
      },
    ],
  });
  const thinkingTs = thinking.ts;
  if (!thinkingTs) {
    throw new Error('Unable to post thinking message.');
  }

  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const attemptPrompt = attempt === 1 ? prompt : buildRetryPrompt(prompt, lastError, lastOutput);
    const startedAt = Date.now();
    const result = await thread.run(attemptPrompt, { outputSchema });
    const latencyMs = Date.now() - startedAt;
    const usage = (result as { usage?: unknown }).usage;
    const structured = extractStructuredOutput(result);
    if (logger.debug) {
      const outputJson = safeStringify(structured);
      logger.debug('Codex structured output', { threadKey, attempt, output: structured, output_json: outputJson });
    }
    lastOutput = structured;
    logger.info('Codex run complete', { threadKey, latencyMs, usage, attempt });

    const output = coerceBlockKitMessage(structured);
    if (!output) {
      lastError = 'Output must be a JSON object with text and blocks.';
      logger.warn('Codex output missing required fields', { threadKey, attempt });
      continue;
    }

    try {
      const response = await client.chat.update({
        channel,
        ts: thinkingTs,
        text: output.text,
        blocks: output.blocks,
      });
      return { response, output };
    } catch (error) {
      lastError = formatSlackError(error);
      logger.warn('Slack update failed', { threadKey, attempt, error: lastError });
    }
  }

  const fallbackText = `Sorry — I couldn't post a response. ${lastError ?? ''}`.trim();
  try {
    const response = await client.chat.update({
      channel,
      ts: thinkingTs,
      text: fallbackText,
      blocks: [
        {
          type: 'section',
          text: { type: 'mrkdwn', text: fallbackText },
        },
      ],
    });
    return { response, output: { text: fallbackText, blocks: [] } };
  } catch (error) {
    throw new Error(lastError ?? 'Slack update failed after 5 attempts.');
  }
}

function coerceBlockKitMessage(payload: unknown): BlockKitMessage | null {
  if (!payload || typeof payload !== 'object') return null;
  const candidate = payload as { text?: unknown; blocks?: unknown };
  if (typeof candidate.text !== 'string') return null;
  if (!Array.isArray(candidate.blocks)) return null;
  return { text: candidate.text, blocks: candidate.blocks };
}

function buildRetryPrompt(basePrompt: string, error: string | null, lastOutput: unknown): string {
  const outputSnippet = lastOutput ? JSON.stringify(lastOutput) : 'null';
  return [
    basePrompt,
    '',
    'The previous response failed to post to Slack.',
    `Slack error: ${error ?? 'unknown'}`,
    `Previous response JSON: ${outputSnippet}`,
    'Return a corrected Block Kit JSON object that satisfies the output schema.',
    'Do NOT include fields, accessories, buttons, or placeholder URLs unless the user explicitly asked.',
    'For simple replies, return only: {"text": "...", "blocks":[{"type":"section","text":{"type":"mrkdwn","text":"..."}}]}',
  ].join('\n');
}

function formatSlackError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return 'Unknown Slack error';
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return '"[unserializable]"';
  }
}
