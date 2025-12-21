import { type Logger } from '../logger.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { type ThreadStore, type ThreadRecord } from '../store/threadStore.js';
import { buildThreadOptions, type CodexClient } from '../codex/client.js';
import { type AppConfig } from '../config.js';
import { runCodexAndPost } from './codexResponder.js';
import { type SlackClientLike, type SlackMessage, type MentionEvent } from './types.js';

export interface MentionDeps {
  client: SlackClientLike;
  store: ThreadStore;
  codex: CodexClient;
  config: AppConfig;
  logger: Logger;
  botUserId: string;
  blockKitOutputSchema: object;
}

export async function handleAppMention(
  params: { event: MentionEvent; ack: () => Promise<void> },
  deps: MentionDeps,
): Promise<void> {
  const { event, ack } = params;
  const { client, store, codex, config, logger, botUserId, blockKitOutputSchema } = deps;

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
  const intro = record ? undefined : await loadBlockKitGuide(logger);
  const prompt = buildPrompt(event.channel, threadTs, messages, botUserId, intro);

  const { response } = await runCodexAndPost({
    thread,
    prompt,
    outputSchema: blockKitOutputSchema,
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

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const BLOCK_KIT_GUIDE_PATH = path.join(REPO_ROOT, 'conversations-in-blockkit.md');
let blockKitGuideCache: string | null = null;

const BLOCK_KIT_GUIDE_FALLBACK = [
  'Block Kit Response Guidance (internal, do not repeat):',
  '- Respond with a JSON object that includes "text" and "blocks".',
  '- Avoid interactive elements unless the user explicitly asks for them.',
  '- Do not include image blocks or accessories unless the user explicitly asked for images.',
  '- For simple replies, use a single section block with just text; no fields, accessories, or buttons.',
].join('\n');

async function loadBlockKitGuide(logger: Logger): Promise<string> {
  if (blockKitGuideCache) return blockKitGuideCache;
  try {
    const guide = await fs.readFile(BLOCK_KIT_GUIDE_PATH, 'utf8');
    blockKitGuideCache = guide.trim();
  } catch (error) {
    logger.warn(`Failed to load block kit guide at ${BLOCK_KIT_GUIDE_PATH}, using fallback`, error);
    blockKitGuideCache = BLOCK_KIT_GUIDE_FALLBACK;
  }
  return blockKitGuideCache;
}

export function buildPrompt(
  channel: string,
  threadTs: string,
  messages: SlackMessage[],
  botUserId: string,
  intro?: string,
): string {
  const lines = messages.map((msg) => {
    const who = msg.user ? `@${msg.user}` : '@unknown';
    const body = stripBotMention(msg.text ?? '', botUserId);
    return `- [${msg.ts ?? 'unknown'}] ${who}: ${body}`;
  });

  if (lines.length === 0) {
    lines.push('- (no new messages)');
  }

  const hints: string[] = [];
  if (wantsChecklist(messages)) {
    hints.push(
      'Checklist request: respond with an input block that uses a checkboxes element (action_id required) and a short label. Do not return a plain markdown list.',
    );
  }

  const introLines = intro ? [intro, ''] : [];
  const hintLines = hints.length > 0 ? [...hints, ''] : [];
  return [
    ...introLines,
    ...hintLines,
    'Messages since last response:',
    ...lines,
    '',
    'Respond with Block Kit JSON that matches the output schema.',
  ].join('\n');
}

function wantsChecklist(messages: SlackMessage[]): boolean {
  return messages.some((msg) => /check\s*list|checklist|to[-\s]?do list|todo list/i.test(msg.text ?? ''));
}
