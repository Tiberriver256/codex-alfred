import { type Logger } from '../logger.js';
import { type ThreadStore, type ThreadRecord } from '../store/threadStore.js';
import { buildThreadOptions, extractStructuredOutput, type CodexClient } from '../codex/client.js';
import { type BlockKitMessage, type BlockKitValidationResult } from '../blockkit/validator.js';
import { type AppConfig } from '../config.js';

export interface SlackClientLike {
  conversations: {
    replies: (args: { channel: string; ts: string; oldest?: string }) => Promise<{ messages?: SlackMessage[] }>;
  };
  chat: {
    postMessage: (args: { channel: string; thread_ts: string; text: string; blocks: unknown[] }) => Promise<{ ts?: string }>;
  };
}

export interface SlackMessage {
  ts?: string;
  text?: string;
  user?: string;
  subtype?: string;
  bot_id?: string;
}

export interface MentionEvent {
  channel: string;
  ts: string;
  thread_ts?: string;
  text?: string;
  user?: string;
}

export interface MentionDeps {
  client: SlackClientLike;
  store: ThreadStore;
  codex: CodexClient;
  config: AppConfig;
  logger: Logger;
  botUserId: string;
  validateBlockKit: (payload: unknown) => BlockKitValidationResult;
  blockKitSchema: object;
  blockKitOutputSchema: object;
}

export async function handleAppMention(
  params: { event: MentionEvent; ack: () => Promise<void> },
  deps: MentionDeps,
): Promise<void> {
  const { event, ack } = params;
  const { client, store, codex, config, logger, botUserId, validateBlockKit, blockKitSchema, blockKitOutputSchema } =
    deps;

  await ack();

  const threadTs = event.thread_ts ?? event.ts;
  const threadKey = `${event.channel}:${threadTs}`;

  const record = store.get(threadKey);
  let thread;
  const threadOptions = buildThreadOptions(config.workDir, config.sandbox, config.codexArgs);

  if (record?.codexThreadId) {
    thread = await codex.resumeThread(record.codexThreadId, threadOptions);
  } else {
    thread = await codex.startThread(threadOptions);
  }

  const replies = await retryOnce(
    () =>
      client.conversations.replies({
        channel: event.channel,
        ts: threadTs,
        oldest: record?.lastResponseTs,
      }),
    logger,
    'conversations.replies',
  );

  const messages = filterMessages(replies.messages ?? [], botUserId, record?.lastResponseTs);
  const prompt = buildPrompt(event.channel, threadTs, messages, botUserId);

  const { response, output } = await runWithSlackRetries({
    thread,
    prompt,
    blockKitOutputSchema,
    validateBlockKit,
    logger,
    threadKey,
    client,
    channel: event.channel,
    threadTs,
  });

  const lastResponseTs = response.ts ?? record?.lastResponseTs ?? threadTs;
  const lastSeenUserTs = messages.length > 0 ? messages[messages.length - 1].ts : record?.lastSeenUserTs;
  const threadId = thread.id ?? record?.codexThreadId;
  const patch: Partial<ThreadRecord> = { lastResponseTs, lastSeenUserTs };
  if (threadId) patch.codexThreadId = threadId;

  if (record) {
    await store.update(threadKey, patch);
  } else {
    await store.set({ threadKey, ...patch });
  }

  logger.info(`Responded to ${threadKey}`);
}

async function runWithSlackRetries(params: {
  thread: { run: (prompt: string, options: { outputSchema: object }) => Promise<unknown>; id: string | null };
  prompt: string;
  blockKitOutputSchema: object;
  validateBlockKit: (payload: unknown) => BlockKitValidationResult;
  logger: Logger;
  threadKey: string;
  client: SlackClientLike;
  channel: string;
  threadTs: string;
}): Promise<{ response: { ts?: string }; output: BlockKitMessage }> {
  const { thread, prompt, blockKitOutputSchema, validateBlockKit, logger, threadKey, client, channel, threadTs } = params;
  let lastError: string | null = null;
  let lastOutput: unknown = null;

  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const attemptPrompt = attempt === 1 ? prompt : buildRetryPrompt(prompt, lastError, lastOutput);
    const startedAt = Date.now();
    const result = await thread.run(attemptPrompt, { outputSchema: blockKitOutputSchema });
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
      lastError = 'Output was not a JSON object with text and blocks.';
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

async function retryOnce<T>(fn: () => Promise<T>, logger: Logger, label: string): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    logger.warn(`${label} failed, retrying once`, error);
    return fn();
  }
}

export function filterMessages(messages: SlackMessage[], botUserId: string, lastResponseTs?: string): SlackMessage[] {
  return messages
    .filter((msg) => isUserMessage(msg, botUserId))
    .filter((msg) => isNewerThan(msg.ts, lastResponseTs))
    .map((msg) => ({
      ...msg,
      text: stripBotMention(msg.text ?? '', botUserId),
    }))
    .filter((msg) => Boolean(msg.text?.trim()));
}

function isUserMessage(message: SlackMessage, botUserId: string): boolean {
  if (message.subtype) return false;
  if (!message.user) return false;
  if (message.user === botUserId) return false;
  if (message.bot_id) return false;
  return true;
}

function isNewerThan(ts?: string, last?: string): boolean {
  if (!ts) return false;
  if (!last) return true;
  return Number(ts) > Number(last);
}

export function stripBotMention(text: string, botUserId: string): string {
  const mention = new RegExp(`<@${botUserId}>`, 'g');
  return text.replace(mention, '').trim();
}

export function buildPrompt(channel: string, threadTs: string, messages: SlackMessage[], botUserId: string): string {
  const lines = messages.map((msg) => {
    const who = msg.user ? `@${msg.user}` : '@unknown';
    const body = stripBotMention(msg.text ?? '', botUserId);
    return `- [${msg.ts ?? 'unknown'}] ${who}: ${body}`;
  });

  if (lines.length === 0) {
    lines.push('- (no new messages)');
  }

  return [
    `Thread: ${channel} / ${threadTs}`,
    'Messages since last response:',
    ...lines,
    '',
    'Respond with Block Kit JSON that matches the output schema.',
  ].join('\n');
}
