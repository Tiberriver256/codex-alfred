import { type Logger } from '../logger.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { type ThreadStore, type ThreadRecord } from '../store/threadStore.js';
import { buildThreadOptions, type CodexClient } from '../codex/client.js';
import { type AppConfig } from '../config.js';
import { runCodexAndPost } from './codexResponder.js';
import { type SlackClientLike, type SlackMessage, type MentionEvent, type SlackFile } from './types.js';
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
    if (work.hasSeenMention(threadKey, event.ts)) {
      logger.info('Skipping duplicate mention while busy', { threadKey, eventTs: event.ts });
      return;
    }
    const busyMessage = await postBusyMessage({ client, channel: event.channel, threadTs });
    work.queueMention(threadKey, event, busyMessage?.ts);
    logger.info('Queued mention while busy', {
      threadKey,
      busyTs: busyMessage?.ts,
      source: event.source ?? 'slack',
    });
    return;
  }

  const record = store.get(threadKey);
  const threadOptions = buildThreadOptions(config.workDir, config.sandbox, config.codexArgs);
  const abortController = new AbortController();
  work.begin(threadKey, abortController, event.ts);

  let thread: Awaited<ReturnType<CodexClient['startThread']>> | undefined;
  let messages: SlackMessage[] = [];
  let response: { ts?: string } | undefined;
  let replies: { messages?: SlackMessage[] } | undefined;
  let attachments: AttachmentInfo[] = [];
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
    const downloadResult = await downloadSlackAttachments(messages, config.botToken, logger);
    attachments = downloadResult.attachments;
    const prompt = buildPrompt(
      event.channel,
      threadTs,
      messages,
      botUserId,
      intro,
      downloadResult.attachments,
      downloadResult.failures,
    );
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
    .filter((msg) => Boolean(msg.text?.trim()) || Boolean(msg.files && msg.files.length > 0));
}

function isUserMessage(message: SlackMessage, botUserId: string): boolean {
  if (message.subtype && message.subtype !== 'file_share' && !(message.files && message.files.length > 0)) {
    return false;
  }
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

export interface AttachmentInfo {
  name: string;
  path: string;
}

export interface AttachmentFailure {
  name: string;
  reason: string;
}

export function buildPrompt(
  channel: string,
  threadTs: string,
  messages: SlackMessage[],
  botUserId: string,
  intro?: string,
  attachments: AttachmentInfo[] = [],
  attachmentFailures: AttachmentFailure[] = [],
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
  const attachmentLines =
    attachments.length > 0
      ? [
          'Attachments available (downloaded for you):',
          ...attachments.map((item) => `- ${item.name}: ${item.path}`),
          '',
        ]
      : [];

  const failureLines =
    attachmentFailures.length > 0
      ? [
          'Attachment download issues:',
          ...attachmentFailures.map((failure) => `- ${failure.name}: ${failure.reason}`),
          '',
        ]
      : [];

  return [
    ...introLines,
    'Messages since last response:',
    ...lines,
    '',
    ...attachmentLines,
    ...failureLines,
    'Respond with Block Kit JSON that matches the output schema.',
  ].join('\n');
}

function getSlackFileUrl(file: SlackFile): string | null {
  if (file.url_private_download) return file.url_private_download;
  if (file.url_private) return file.url_private;
  return null;
}

async function downloadSlackAttachments(
  messages: SlackMessage[],
  botToken: string,
  logger: Logger,
): Promise<{ attachments: AttachmentInfo[]; failures: AttachmentFailure[] }> {
  const files = messages.flatMap((msg) => msg.files ?? []);
  if (files.length === 0) return { attachments: [], failures: [] };

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'alfred-attachments-'));
  const seen = new Set<string>();
  const results: AttachmentInfo[] = [];
  const failures: AttachmentFailure[] = [];
  let downloaded = 0;

  for (let i = 0; i < files.length; i += 1) {
    const file = files[i];
    const url = getSlackFileUrl(file);
    if (!url) continue;
    const key = file.id ?? url;
    if (seen.has(key)) continue;
    seen.add(key);

    const filename = sanitizeFilename(file.name ?? file.title ?? file.id ?? `attachment-${i + 1}`);
    const target = uniquePath(path.join(dir, filename), results.map((item) => item.path));
    try {
      const res = await fetchSlackFile(url, botToken);
      if (!res.ok) {
        const reason = `download failed (HTTP ${res.status})`;
        logger.warn('Failed to download Slack attachment', { status: res.status, name: filename, url });
        failures.push({ name: filename, reason });
        continue;
      }

      const arrayBuffer = await res.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      const contentType = res.headers.get('content-type')?.toLowerCase() ?? '';
      if (looksLikeHtml(buffer, contentType)) {
        const reason = 'download returned HTML (check Slack permissions)';
        logger.warn('Slack attachment download returned HTML', { name: filename, url, contentType });
        failures.push({ name: filename, reason });
        continue;
      }

      await fs.writeFile(target, buffer);
      results.push({ name: filename, path: target });
      downloaded += 1;
    } catch (error) {
      logger.warn('Failed to download Slack attachment', { error, name: filename });
      failures.push({ name: filename, reason: 'download failed (network error)' });
    }
  }

  if (logger.debug) {
    logger.debug('Slack attachments downloaded', { total: files.length, downloaded, dir, failures: failures.length });
  }
  return { attachments: results, failures };
}

async function fetchSlackFile(url: string, botToken: string): Promise<Response> {
  let nextUrl: string | null = url;
  for (let i = 0; i < 5; i += 1) {
    if (!nextUrl) break;
    const res: Response = await fetch(nextUrl, {
      headers: { Authorization: `Bearer ${botToken}` },
      redirect: 'manual',
    });
    if (res.status >= 300 && res.status < 400) {
      const location: string | null = res.headers.get('location');
      if (location) {
        nextUrl = new URL(location, nextUrl).toString();
        continue;
      }
    }
    return res;
  }
  return fetch(url, { headers: { Authorization: `Bearer ${botToken}` } });
}

function looksLikeHtml(buffer: Buffer, contentType: string): boolean {
  if (contentType.includes('text/html') || contentType.includes('application/xhtml')) return true;
  const snippet = buffer.slice(0, 64).toString('utf8').trim().toLowerCase();
  return snippet.startsWith('<!doctype html') || snippet.startsWith('<html');
}

function sanitizeFilename(value: string): string {
  const base = path.basename(value);
  const cleaned = base.replace(/[^\w.\-]+/g, '_');
  return cleaned || 'attachment';
}

function uniquePath(candidate: string, existing: string[]): string {
  if (!existing.includes(candidate)) return candidate;
  const ext = path.extname(candidate);
  const base = candidate.slice(0, candidate.length - ext.length);
  for (let i = 2; i < 1000; i += 1) {
    const next = `${base}-${i}${ext}`;
    if (!existing.includes(next)) return next;
  }
  return `${base}-${Date.now()}${ext}`;
}
