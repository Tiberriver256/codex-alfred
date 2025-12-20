import { type Logger } from '../logger.js';
import { type ThreadStore, type ThreadRecord } from '../store/threadStore.js';
import { buildThreadOptions, extractStructuredOutput, type CodexClient } from '../codex/client.js';
import { type BlockKitMessage, buildFallbackMessage, type BlockKitValidationResult } from '../blockkit/validator.js';
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
}

export async function handleAppMention(
  params: { event: MentionEvent; ack: () => Promise<void> },
  deps: MentionDeps,
): Promise<void> {
  const { event, ack } = params;
  const { client, store, codex, config, logger, botUserId, validateBlockKit, blockKitSchema } = deps;

  await ack();

  const threadTs = event.thread_ts ?? event.ts;
  const threadKey = `${event.channel}:${threadTs}`;

  let record = store.get(threadKey);
  let thread;
  const threadOptions = buildThreadOptions(config.workDir, config.sandbox, config.codexArgs);

  if (record) {
    thread = await codex.getThread(record.codexThreadId, threadOptions);
  } else {
    thread = await codex.startThread(threadOptions);
    record = {
      threadKey,
      codexThreadId: thread.id,
    };
    await store.set(record);
  }

  const replies = await client.conversations.replies({
    channel: event.channel,
    ts: threadTs,
    oldest: record.lastResponseTs,
  });

  const messages = filterMessages(replies.messages ?? [], botUserId, record.lastResponseTs);
  const prompt = buildPrompt(event.channel, threadTs, messages, botUserId);

  let output: BlockKitMessage;

  try {
    const result = await thread.run(prompt, { outputSchema: blockKitSchema });
    const structured = extractStructuredOutput(result);
    const validation = validateBlockKit(structured);
    if (validation.ok) {
      output = structured as BlockKitMessage;
    } else {
      output = buildFallbackMessage(validation.errors?.[0] ?? 'Invalid Block Kit payload');
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown Codex error';
    output = buildFallbackMessage(message);
  }

  const response = await client.chat.postMessage({
    channel: event.channel,
    thread_ts: threadTs,
    text: output.text,
    blocks: output.blocks,
  });

  const lastResponseTs = response.ts ?? record.lastResponseTs ?? threadTs;
  const lastSeenUserTs = messages.length > 0 ? messages[messages.length - 1].ts : record.lastSeenUserTs;

  await store.update(threadKey, {
    lastResponseTs,
    lastSeenUserTs,
  } as Partial<ThreadRecord>);

  logger.info(`Responded to ${threadKey}`);
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
    'Respond in Block Kit JSON according to the output schema.',
  ].join('\n');
}
