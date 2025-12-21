import { extractStructuredOutput, type CodexThread } from '../codex/client.js';
import { type BlockKitMessage, type BlockKitValidationResult } from '../blockkit/validator.js';
import { type Logger } from '../logger.js';
import { type SlackClientLike } from './types.js';

export async function runCodexAndPost(params: {
  thread: CodexThread;
  prompt: string;
  outputSchema: object;
  validateBlockKit: (payload: unknown) => BlockKitValidationResult;
  logger: Logger;
  threadKey: string;
  client: SlackClientLike;
  channel: string;
  threadTs: string;
}): Promise<{ response: { ts?: string }; output: BlockKitMessage }> {
  const { thread, prompt, outputSchema, validateBlockKit, logger, threadKey, client, channel, threadTs } = params;
  let lastError: string | null = null;
  let lastOutput: unknown = null;

  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const attemptPrompt = attempt === 1 ? prompt : buildRetryPrompt(prompt, lastError, lastOutput);
    const startedAt = Date.now();
    const result = await thread.run(attemptPrompt, { outputSchema });
    const latencyMs = Date.now() - startedAt;
    const usage = (result as { usage?: unknown }).usage;
    const structured = extractStructuredOutput(result);
    lastOutput = structured;
    logger.info('Codex run complete', { threadKey, latencyMs, usage, attempt });

    const validation = validateBlockKit(structured);
    if (!validation.ok) {
      logger.warn('Block Kit validation failed', { threadKey, attempt, errors: validation.errors });
    }

    const output = coerceBlockKitMessage(structured);
    if (!output) {
      lastError = 'Output must be a JSON object with text and blocks.';
      logger.warn('Codex output missing required fields', { threadKey, attempt });
      continue;
    }

    try {
      const response = await client.chat.postMessage({
        channel,
        thread_ts: threadTs,
        text: output.text,
        blocks: output.blocks,
      });
      return { response, output };
    } catch (error) {
      lastError = formatSlackError(error);
      logger.warn('Slack postMessage failed', { threadKey, attempt, error: lastError });
    }
  }

  throw new Error(lastError ?? 'Slack postMessage failed after 5 attempts.');
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
  ].join('\n');
}

function formatSlackError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return 'Unknown Slack error';
}
