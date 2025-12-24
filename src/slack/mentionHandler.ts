import { type Logger } from '../logger.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { type ThreadStore, type ThreadRecord } from '../store/threadStore.js';
import { buildThreadOptions, type CodexClient } from '../codex/client.js';
import { type AppConfig } from '../config.js';
import { runCodexAndPost } from './codexResponder.js';
import { type SlackClientLike, type SlackMessage, type MentionEvent } from './types.js';
import { ThreadWorkManager } from './threadWork.js';

export interface MentionDeps {
  client: SlackClientLike;
  store: ThreadStore;
  codex: CodexClient;
  work: ThreadWorkManager;
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
  const { client, store, codex, work, config, logger, botUserId, blockKitOutputSchema } = deps;

  await ack();

  const threadTs = event.thread_ts ?? event.ts;
  const threadKey = `${event.channel}:${threadTs}`;

  if (work.isBusy(threadKey)) {
    const busyMessage = await postBusyMessage({ client, channel: event.channel, threadTs });
    work.queueMention(threadKey, event, busyMessage?.ts);
    logger.info('Queued mention while busy', { threadKey, busyTs: busyMessage?.ts });
    return;
  }

  const record = store.get(threadKey);
  const threadOptions = buildThreadOptions(config.workDir, config.sandbox, config.codexArgs);
  const abortController = new AbortController();
  work.begin(threadKey, abortController);

  let thread: Awaited<ReturnType<CodexClient['startThread']>> | undefined;
  let messages: SlackMessage[] = [];
  let response: { ts?: string } | undefined;
  let replies: { messages?: SlackMessage[] } | undefined;
  let queuedMentions: MentionEvent[] = [];
  try {
    const activeThread = record?.codexThreadId
      ? await codex.resumeThread(record.codexThreadId, threadOptions)
      : await codex.startThread(threadOptions);
    thread = activeThread;

    replies = await retryOnce(
      () =>
        client.conversations.replies({
          channel: event.channel,
          ts: threadTs,
          oldest: record?.lastResponseTs,
        }),
      logger,
      'conversations.replies',
    );

    messages = filterMessages(replies.messages ?? [], botUserId, record?.lastResponseTs);
    const intro = record ? undefined : await loadBlockKitGuide(logger);
    const prompt = buildPrompt(event.channel, threadTs, messages, botUserId, intro);
    ({ response } = await runCodexAndPost({
      thread: activeThread,
      prompt,
      outputSchema: blockKitOutputSchema,
      logger,
      threadKey,
      client,
      channel: event.channel,
      threadTs,
      workDir: config.workDir,
      dataDir: config.dataDir,
      sandbox: config.sandbox,
      abortSignal: abortController.signal,
    }));
  } finally {
    const { queued, busyMessages } = work.end(threadKey);
    queuedMentions = queued;
    await deleteBusyMessages(client, event.channel, busyMessages, logger, threadKey);
  }

  if (response && replies) {
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

  if (queuedMentions.length > 0) {
    await flushQueuedMentions(queuedMentions, deps);
  }
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

async function postBusyMessage(params: {
  client: SlackClientLike;
  channel: string;
  threadTs: string;
}): Promise<{ ts?: string } | null> {
  const { client, channel, threadTs } = params;
  const text =
    'Alfred is busy — I’ll pass along your message when he finishes. ' +
    'Press *Interrupt now* to stop his work and deliver this immediately.';
  try {
    return await client.chat.postMessage({
      channel,
      thread_ts: threadTs,
      text,
      blocks: [
        { type: 'section', text: { type: 'mrkdwn', text } },
        {
          type: 'actions',
          elements: [
            {
              type: 'button',
              text: { type: 'plain_text', text: 'Interrupt now' },
              action_id: 'interrupt-now',
            },
          ],
        },
      ],
    });
  } catch {
    return null;
  }
}

export async function deleteBusyMessages(
  client: SlackClientLike,
  channel: string,
  busyMessages: string[],
  logger: Logger,
  threadKey: string,
): Promise<void> {
  if (!client.chat.delete) return;
  const unique = [...new Set(busyMessages)].filter(Boolean);
  for (const ts of unique) {
    try {
      await client.chat.delete({ channel, ts });
    } catch (error) {
      logger.warn('Failed to delete busy message', { threadKey, ts, error });
    }
  }
}

export async function flushQueuedMentions(queued: MentionEvent[], deps: MentionDeps): Promise<void> {
  if (queued.length === 0) return;
  const nextEvent = queued[queued.length - 1];
  if (!nextEvent) return;
  await handleAppMention({ event: nextEvent, ack: async () => undefined }, deps);
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
  '- Respond with a JSON object that includes "text", "blocks", and "attachments" (array).',
  '- Avoid interactive elements unless the user explicitly asks for them or a checklist helps the user track items.',
  '- Do not include image blocks or accessories unless the user explicitly asked for images.',
  '- For simple replies, use a single section block with just text; no fields, accessories, or buttons.',
  '- Never emit section blocks with empty or whitespace-only text; do not use spacer blocks.',
  '- For tracking-only checklists, use an input block with checkboxes and no Submit button.',
  '- Only include a Submit button when you need the user to submit selections or provide input.',
  '- If no files should be attached, set "attachments" to [].',
  '- Attachments must use workspace-relative paths; do not reference /tmp.',
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

  const introLines = intro ? [intro, ''] : [];
  return [
    ...introLines,
    'Messages since last response:',
    ...lines,
    '',
    'Respond with Block Kit JSON that matches the output schema.',
  ].join('\n');
}
