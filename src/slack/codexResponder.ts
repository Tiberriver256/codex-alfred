import { extractStructuredOutput, type CodexThread, type CodexThreadEvent } from '../codex/client.js';
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
  const statusLimiter = createStatusLimiter();
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
    statusLimiter.lastText = '';
    statusLimiter.lastUpdatedAt = 0;
    const attemptPrompt = attempt === 1 ? prompt : buildRetryPrompt(prompt, lastError, lastOutput);
    if (attempt > 1) {
      await maybeUpdateStatus(client, channel, thinkingTs, statusLimiter, '_Retrying..._');
    }

    const startedAt = Date.now();
    let usage: { input_tokens: number; cached_input_tokens: number; output_tokens: number } | null = null;
    let finalText: string | null = null;
    let threadId = thread.id ?? null;

    try {
      if (typeof thread.runStreamed === 'function') {
        const stream = await thread.runStreamed(attemptPrompt, { outputSchema });
        for await (const event of stream.events) {
          if (event.type === 'thread.started') {
            threadId = event.thread_id;
          }
          if (event.type === 'turn.completed') {
            usage = event.usage;
          }
          if (event.type === 'turn.failed') {
            throw new Error(event.error.message);
          }
          if (event.type === 'item.completed' && event.item.type === 'agent_message') {
            const text = event.item.text;
            if (typeof text === 'string') {
              finalText = text;
            }
          }

          const statusText = statusFromEvent(event);
          if (statusText) {
            await maybeUpdateStatus(client, channel, thinkingTs, statusLimiter, statusText);
          }
        }
      } else {
        const result = await thread.run(attemptPrompt, { outputSchema });
        usage = (result as { usage?: { input_tokens: number; cached_input_tokens: number; output_tokens: number } }).usage ?? null;
        threadId = thread.id ?? null;
        const text = (result as { finalResponse?: unknown }).finalResponse;
        if (typeof text === 'string') {
          finalText = text;
        } else {
          finalText = JSON.stringify(result);
        }
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : 'Codex stream failed.';
      logger.warn('Codex run failed', { threadKey, threadId, attempt, error: lastError });
      continue;
    }

    const latencyMs = Date.now() - startedAt;
    if (!finalText) {
      lastError = 'Codex did not return a final response.';
      logger.warn('Codex output missing final response', { threadKey, threadId, attempt });
      continue;
    }

    const structured = extractStructuredOutput({ text: finalText });
    if (logger.debug) {
      const outputJson = safeStringify(structured);
      logger.debug('Codex structured output', {
        threadKey,
        threadId,
        attempt,
        output: structured,
        output_json: outputJson,
      });
    }
    lastOutput = structured;
    logger.info('Codex run complete', { threadKey, threadId, latencyMs, usage, attempt });

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

function createStatusLimiter() {
  return {
    lastText: '',
    lastUpdatedAt: 0,
  };
}

async function maybeUpdateStatus(
  client: SlackClientLike,
  channel: string,
  ts: string,
  limiter: { lastText: string; lastUpdatedAt: number },
  text: string,
): Promise<void> {
  const now = Date.now();
  if (text === limiter.lastText && now - limiter.lastUpdatedAt < 15000) return;
  if (now - limiter.lastUpdatedAt < 2500) return;

  limiter.lastText = text;
  limiter.lastUpdatedAt = now;

  try {
    await client.chat.update({
      channel,
      ts,
      text,
      blocks: [
        {
          type: 'section',
          text: { type: 'mrkdwn', text: `_${text}_` },
        },
      ],
    });
  } catch {
    // Ignore status update failures; final response will overwrite.
  }
}

function statusFromEvent(event: CodexThreadEvent): string | null {
  switch (event.type) {
    case 'turn.started':
      return 'Thinking...';
    case 'turn.completed':
      return 'Finalizing response...';
    case 'item.started':
    case 'item.updated':
    case 'item.completed':
      return statusFromItem(event.item, event.type);
    default:
      return null;
  }
}

function statusFromItem(item: { type?: string; [key: string]: unknown }, phase: string): string | null {
  const type = item.type;
  if (!type) return null;

  if (type === 'command_execution') {
    const command = typeof item.command === 'string' ? item.command : 'command';
    const shortCommand = truncate(command, 80);
    return phase === 'item.completed' ? `Command finished: \`${shortCommand}\`` : `Running: \`${shortCommand}\``;
  }

  if (type === 'mcp_tool_call') {
    const server = typeof item.server === 'string' ? item.server : 'tool';
    const tool = typeof item.tool === 'string' ? item.tool : '';
    return phase === 'item.completed' ? `Tool finished: ${server}${tool ? `/${tool}` : ''}` : `Using tool: ${server}${tool ? `/${tool}` : ''}`;
  }

  if (type === 'web_search') {
    const query = typeof item.query === 'string' ? item.query : 'search';
    return phase === 'item.completed' ? `Search complete: ${truncate(query, 80)}` : `Searching: ${truncate(query, 80)}`;
  }

  if (type === 'file_change') {
    return phase === 'item.completed' ? 'File changes completed.' : 'Applying file changes...';
  }

  if (type === 'todo_list') {
    return phase === 'item.completed' ? 'Plan updated.' : 'Updating plan...';
  }

  if (type === 'reasoning') {
    return phase === 'item.completed' ? 'Drafting response...' : 'Thinking...';
  }

  if (type === 'agent_message') {
    return phase === 'item.completed' ? 'Finalizing response...' : 'Drafting response...';
  }

  if (type === 'error') {
    return 'Encountered an error...';
  }

  return null;
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength - 1)}…`;
}
