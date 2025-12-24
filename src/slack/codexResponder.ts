import fs from 'node:fs/promises';
import path from 'node:path';
import { createCodexClient, extractStructuredOutput, type CodexThread, type CodexThreadEvent } from '../codex/client.js';
import { type BlockKitMessage } from '../blockkit/validator.js';
import { type Logger } from '../logger.js';
import { type SlackClientLike } from './types.js';
import { cleanupAttachments, resolveAttachments, type FileAttachment } from './attachmentResolver.js';

export interface AttachmentResult {
  attempted: boolean;
  succeeded: string[];
  failed: Array<{ filename: string; reason: string }>;
}

type StatusSummarizer = {
  summarize: (params: {
    userPrompt: string;
    eventType: string;
    recentEvents: CodexThreadEvent[];
    currentEvent: CodexThreadEvent;
  }) => Promise<string | null>;
};

export async function runCodexAndPost(params: {
  thread: CodexThread;
  prompt: string;
  outputSchema: object;
  logger: Logger;
  threadKey: string;
  client: SlackClientLike;
  channel: string;
  threadTs: string;
  workDir: string;
  dataDir: string;
  sandbox: { mode: 'host' } | { mode: 'docker'; name: string };
  abortSignal?: AbortSignal;
}): Promise<{ response: { ts?: string }; output: BlockKitMessage; attachments?: AttachmentResult }> {
  const { thread, prompt, outputSchema, logger, threadKey, client, channel, threadTs, workDir, dataDir, sandbox, abortSignal } = params;
  let lastError: string | null = null;
  let lastOutput: unknown = null;
  const statusLimiter = createStatusLimiter();
  const userPrompt = extractLastUserPrompt(prompt);
  let summarizer: StatusSummarizer | null = null;
  let summarizerAttempted = false;
  const thinking = await client.chat.postMessage({
    channel,
    thread_ts: threadTs,
    text: 'Thinking...',
    blocks: buildThinkingBlocks('Thinking...'),
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
      await maybeUpdateStatus(client, channel, thinkingTs, statusLimiter, 'Retrying...');
    }

    const startedAt = Date.now();
    const progress = createProgressState(startedAt);
    const stopProgress = startProgressReporter({
      client,
      channel,
      ts: thinkingTs,
      limiter: statusLimiter,
      progress,
    });
    let usage: { input_tokens: number; cached_input_tokens: number; output_tokens: number } | null = null;
    let finalText: string | null = null;
    let structuredOutput: unknown | null = null;
    let sawTurnCompleted = false;
    let threadId = thread.id ?? null;
    const recentEvents: CodexThreadEvent[] = [];

    try {
      if (typeof thread.runStreamed === 'function') {
        const stream = await thread.runStreamed(attemptPrompt, buildRunOptions(outputSchema, abortSignal));
        for await (const event of stream.events) {
          if (logger.debug) {
            logger.debug('Codex stream event', {
              threadKey,
              threadId,
              attempt,
              event: sanitizeForLog(event),
            });
          }
          progress.lastEventAt = Date.now();
          if (event.type === 'thread.started') {
            threadId = event.thread_id;
          }
          if (event.type === 'turn.completed') {
            usage = event.usage;
            sawTurnCompleted = true;
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
          if (statusText && shouldAttemptStatusUpdate(statusLimiter)) {
            if (!summarizer && !summarizerAttempted) {
              summarizerAttempted = true;
              summarizer = await createStatusSummarizer({ workDir, logger });
            }
            const summary = summarizer
              ? await summarizer.summarize({
                  userPrompt,
                  eventType: event.type,
                  recentEvents: recentEvents.slice(-1),
                  currentEvent: event,
                })
              : null;
            const nextStatus = summary ?? statusText;
            progress.lastStatus = nextStatus;
            await maybeUpdateStatus(client, channel, thinkingTs, statusLimiter, nextStatus);
          } else if (statusText) {
            progress.lastStatus = statusText;
          }

          recentEvents.push(event);
          if (recentEvents.length > 3) recentEvents.shift();

          if (finalText && sawTurnCompleted) {
            break;
          }
        }
        if (finalText) {
          structuredOutput = extractStructuredOutput({ text: finalText });
        }
      } else {
        const result = await thread.run(attemptPrompt, buildRunOptions(outputSchema, abortSignal));
        usage = (result as { usage?: { input_tokens: number; cached_input_tokens: number; output_tokens: number } }).usage ?? null;
        threadId = thread.id ?? null;
        structuredOutput = extractStructuredOutput(result);
      }
    } catch (error) {
      stopProgress();
      if (isAbortError(error, abortSignal)) {
        const cancelText = 'Okay — I stopped.';
        await updateFinalMessage(client, channel, thinkingTs, cancelText);
        return { response: { ts: thinkingTs }, output: { text: cancelText, blocks: [] } };
      }
      lastError = error instanceof Error ? error.message : 'Codex stream failed.';
      logger.warn('Codex run failed', { threadKey, threadId, attempt, error: lastError });
      continue;
    }

    const latencyMs = Date.now() - startedAt;
    if (!structuredOutput && !finalText) {
      stopProgress();
      lastError = 'Codex did not return a final response.';
      logger.warn('Codex output missing final response', { threadKey, threadId, attempt });
      continue;
    }
    if (!structuredOutput && finalText) {
      structuredOutput = extractStructuredOutput({ text: finalText });
    }

    const structured = structuredOutput;
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
      stopProgress();
      lastError = 'Output must be a JSON object with text, blocks, and attachments (array).';
      logger.warn('Codex output missing required fields', { threadKey, attempt });
      continue;
    }

    try {
      stopProgress();
      const response = await client.chat.update({
        channel,
        ts: thinkingTs,
        text: output.text,
        blocks: output.blocks,
      });
      let attachmentResult: AttachmentResult | undefined;
      const requestedAttachments = output.attachments ?? [];
      if (requestedAttachments.length > 0) {
        const { resolved, failures: invalidFailures, cleanup } = await resolveAttachments(requestedAttachments, {
          workDir,
          dataDir,
          sandbox,
        });
        attachmentResult = { attempted: true, succeeded: [], failed: [] };
        if (resolved.length > 0) {
          logger.info('Uploading attachments', { threadKey, attachments: resolved.map((item) => item.path) });
          const uploaded = await uploadAttachments({ client, channel, threadTs, attachments: resolved, logger, threadKey });
          attachmentResult.succeeded = uploaded.succeeded;
          attachmentResult.failed = uploaded.failed;
        }
        if (invalidFailures.length > 0) {
          attachmentResult.failed.push(...invalidFailures);
        }
        if (attachmentResult.failed.length > 0) {
          await postAttachmentFailures({ client, channel, threadTs, failures: attachmentResult.failed, logger, threadKey });
        }
        if (cleanup.length > 0) {
          await cleanupAttachments(cleanup);
        }
      }
      return { response, output, attachments: attachmentResult };
    } catch (error) {
      stopProgress();
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

function buildThinkingBlocks(text: string): unknown[] {
  return [
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `_${text}_` },
    },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Cancel' },
          action_id: 'interrupt-run',
        },
      ],
    },
  ];
}

function buildRunOptions(outputSchema: object, abortSignal?: AbortSignal): { outputSchema: object; signal?: AbortSignal } {
  if (!abortSignal) return { outputSchema };
  return { outputSchema, signal: abortSignal };
}

function coerceBlockKitMessage(payload: unknown): BlockKitMessage | null {
  if (!payload || typeof payload !== 'object') return null;
  const candidate = payload as { text?: unknown; blocks?: unknown; attachments?: unknown };
  if (typeof candidate.text !== 'string') return null;
  if (!Array.isArray(candidate.blocks)) return null;
  if (candidate.attachments !== undefined) {
    if (!Array.isArray(candidate.attachments)) return null;
    const attachments: FileAttachment[] = [];
    for (const item of candidate.attachments) {
      if (!item || typeof item !== 'object') return null;
      const raw = item as { path?: unknown; filename?: unknown; title?: unknown };
      if (typeof raw.path !== 'string') return null;
      if (raw.filename !== undefined && typeof raw.filename !== 'string') return null;
      if (raw.title !== undefined && typeof raw.title !== 'string') return null;
      attachments.push({ path: raw.path, filename: raw.filename, title: raw.title });
    }
    return { text: candidate.text, blocks: candidate.blocks, attachments };
  }
  return { text: candidate.text, blocks: candidate.blocks };
}

async function uploadAttachments(params: {
  client: SlackClientLike;
  channel: string;
  threadTs: string;
  attachments: FileAttachment[];
  logger: Logger;
  threadKey: string;
}): Promise<AttachmentResult> {
  const { client, channel, threadTs, attachments, logger, threadKey } = params;
  if (!client.files?.upload && !client.files?.uploadV2) {
    logger.warn('Slack client missing files.upload methods', { threadKey });
    return { attempted: true, succeeded: [], failed: attachments.map((item) => ({
      filename: item.filename ?? path.basename(item.path),
      reason: 'Slack client missing files.upload methods',
    })) };
  }

  const failures: Array<{ filename: string; reason: string }> = [];
  const successes: string[] = [];

  for (const attachment of attachments) {
    try {
      const data = await fs.readFile(attachment.path);
      const filename = attachment.filename ?? path.basename(attachment.path);
      const initialComment = attachment.title;

      if (client.files?.uploadV2) {
        try {
          await client.files.uploadV2({
            channel_id: channel,
            thread_ts: threadTs,
            initial_comment: initialComment,
            file: data,
            filename,
            title: attachment.title ?? filename,
          });
          successes.push(filename);
          continue;
        } catch (error) {
          logger.warn('Slack uploadV2 failed, falling back to upload', { threadKey, error });
        }
      }

      if (client.files?.upload) {
        await client.files.upload({
          channels: channel,
          thread_ts: threadTs,
          filename,
          file: data,
          initial_comment: initialComment,
        });
        successes.push(filename);
      }
    } catch (error) {
      const reason = formatSlackError(error);
      failures.push({ filename: attachment.filename ?? path.basename(attachment.path), reason });
      logger.warn('Failed to upload attachment', { threadKey, path: attachment.path, error });
    }
  }

  return { attempted: true, succeeded: successes, failed: failures };
}

async function postAttachmentFailures(params: {
  client: SlackClientLike;
  channel: string;
  threadTs: string;
  failures: Array<{ filename: string; reason: string }>;
  logger: Logger;
  threadKey: string;
}): Promise<void> {
  const { client, channel, threadTs, failures, logger, threadKey } = params;
  if (failures.length === 0) return;
  const lines = failures.map((failure) => `• ${failure.filename}: ${failure.reason}`);
  const text = [
    'I couldn’t attach the file(s).',
    ...lines,
    'If this is a permissions issue, ensure the Slack app has `files:write` and is reinstalled.',
  ].join('\n');

  try {
    await client.chat.postMessage({
      channel,
      thread_ts: threadTs,
      text,
      blocks: [
        {
          type: 'section',
          text: { type: 'mrkdwn', text },
        },
      ],
    });
  } catch (error) {
    logger.warn('Failed to post attachment error message', { threadKey, error });
  }
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
    'For simple replies, return only: {"text": "...", "blocks":[{"type":"section","text":{"type":"mrkdwn","text":"..."}}], "attachments":[]}',
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

function shouldAttemptStatusUpdate(limiter: { lastText: string; lastUpdatedAt: number }): boolean {
  const now = Date.now();
  if (now - limiter.lastUpdatedAt < 2500) return false;
  return true;
}

function createProgressState(startedAt: number) {
  return {
    startedAt,
    lastEventAt: startedAt,
    lastStatus: 'Thinking...',
    updateInFlight: false,
  };
}

function startProgressReporter(params: {
  client: SlackClientLike;
  channel: string;
  ts: string;
  limiter: { lastText: string; lastUpdatedAt: number };
  progress: {
    startedAt: number;
    lastEventAt: number;
    lastStatus: string;
    updateInFlight: boolean;
  };
}): () => void {
  const { client, channel, ts, limiter, progress } = params;
  const interval = setInterval(async () => {
    const now = Date.now();
    if (progress.updateInFlight) return;
    if (now - progress.lastEventAt < 30000) return;

    const elapsed = formatElapsed(progress.startedAt, now);
    const base = progress.lastStatus || 'Working...';
    const text = `${base} (${elapsed} elapsed)`;
    progress.updateInFlight = true;
    try {
      await maybeUpdateStatus(client, channel, ts, limiter, text);
    } finally {
      progress.updateInFlight = false;
    }
  }, 15000);

  return () => clearInterval(interval);
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
    await updateStatusMessage(client, channel, ts, text);
  } catch {
    // Ignore status update failures; final response will overwrite.
  }
}

async function updateStatusMessage(
  client: SlackClientLike,
  channel: string,
  ts: string,
  text: string,
): Promise<void> {
  try {
    await client.chat.update({
      channel,
      ts,
      text,
      blocks: buildThinkingBlocks(text),
    });
  } catch {
    // Ignore interim status update failures.
  }
}

async function updateFinalMessage(
  client: SlackClientLike,
  channel: string,
  ts: string,
  text: string,
): Promise<void> {
  try {
    await client.chat.update({
      channel,
      ts,
      text,
      blocks: [
        {
          type: 'section',
          text: { type: 'mrkdwn', text },
        },
      ],
    });
  } catch {
    // Ignore final update failures during cancellation.
  }
}

function isAbortError(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  if (error instanceof Error) {
    const name = error.name.toLowerCase();
    if (name.includes('abort')) return true;
    const message = error.message.toLowerCase();
    if (message.includes('aborted') || message.includes('cancelled') || message.includes('canceled')) {
      return true;
    }
  }
  return false;
}

async function createStatusSummarizer(params: { workDir: string; logger: Logger }): Promise<StatusSummarizer | null> {
  const { workDir, logger } = params;
  try {
    const client = await createCodexClient();
    const thread = await client.startThread({
      workingDirectory: workDir,
      skipGitRepoCheck: true,
      approvalPolicy: 'never',
      model: 'gpt-5.1-codex-mini',
      modelReasoningEffort: 'low',
      networkAccessEnabled: false,
      webSearchEnabled: false,
    });

    const outputSchema = {
      type: 'object',
      properties: {
        summary: { type: 'string' },
      },
      required: ['summary'],
      additionalProperties: false,
    };

    return {
      summarize: async ({ userPrompt, eventType, recentEvents, currentEvent }) => {
        const subject = statusSubjectFromPrompt(userPrompt);
        const eventHint = statusEventHint(currentEvent, userPrompt);
        const prompt = buildStatusSummaryPrompt({
          userPrompt,
          eventType,
          recentEvents,
          currentEvent,
          subject,
          eventHint,
        });
        const startedAt = Date.now();
        try {
          const result = await thread.run(prompt, { outputSchema });
          const structured = extractStructuredOutput(result);
          const summary =
            structured && typeof structured === 'object' && 'summary' in structured
              ? String((structured as { summary?: string }).summary ?? '')
              : '';
          const cleaned = summary.trim();
          if (logger.debug) {
            logger.debug('Status summary generated', {
              eventType,
              latencyMs: Date.now() - startedAt,
              summary: cleaned,
            });
          }
          return cleaned || null;
        } catch (error) {
          logger.warn('Status summary failed', { eventType, error });
          return null;
        }
      },
    };
  } catch (error) {
    logger.warn('Status summarizer unavailable', error);
    return null;
  }
}

export function buildStatusSummaryPrompt(params: {
  userPrompt: string;
  eventType: string;
  recentEvents: CodexThreadEvent[];
  currentEvent: CodexThreadEvent;
  subject: string;
  eventHint: string;
}): string {
  const { userPrompt, eventType, recentEvents, currentEvent, subject, eventHint } = params;
  return [
    'You write short Slack status lines for Alfred.',
    'Return JSON: {"summary":"..."} only.',
    'One sentence, <= 12 words.',
    'Start with a single emoji, then a space.',
    'Speak as Alfred in first person (e.g., "I’m…").',
    'Address the user as "you". Avoid "we" and third-person references.',
    'Include one *bold* or _italic_ emphasis on the main object.',
    'Explain what you are doing and why, tied to the user request.',
    'Translate technical work into user-friendly language.',
    'Avoid file paths, commands, IDs, and internal jargon.',
    'Avoid vague phrasing like "your request".',
    'Use lowercase "your" unless the sentence starts.',
    'Use ✅ only when the turn is completed.',
    'If not turn.completed, use 📝 for thread.started, ⏳ for turn.started, 🔍 for item.*.',
    '',
    `Subject hint: ${subject}`,
    `Event hint: ${eventHint}`,
    `User prompt: ${userPrompt}`,
    `Event type: ${eventType}`,
    `Recent events: ${JSON.stringify(recentEvents.map(compactEventForSummary))}`,
    `Current event: ${JSON.stringify(compactEventForSummary(currentEvent))}`,
  ].join('\n');
}

export function compactEventForSummary(event: CodexThreadEvent): Record<string, unknown> {
  if (event.type === 'item.started' || event.type === 'item.updated' || event.type === 'item.completed') {
    return { type: event.type, item: { type: event.item.type } };
  }
  if (event.type === 'turn.completed') {
    return { type: event.type };
  }
  if (event.type === 'turn.started') {
    return { type: event.type };
  }
  if (event.type === 'thread.started') {
    return { type: event.type };
  }
  if (event.type === 'turn.failed') {
    return { type: event.type, error: event.error.message };
  }
  if (event.type === 'error') {
    return { type: event.type, message: event.message };
  }
  return { type: event.type };
}

export function extractLastUserPrompt(prompt: string): string {
  const lines = prompt.split('\n');
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    const match = line.match(/^\-\s+\[[^\]]+\]\s+@[^:]+:\s*(.+)$/);
    if (match?.[1]) return match[1].trim();
  }
  return 'User request.';
}

export function statusSubjectFromPrompt(prompt: string): string {
  const text = prompt.toLowerCase();
  if (/(ynab|budget|category|transaction|reconcile)/i.test(text)) return 'budget';
  if (/(shopping|grocery|groceries)/i.test(text)) return 'shopping list';
  if (/(todo|to-do|checklist)/i.test(text)) return 'to-do list';
  if (/(cleanup|clean up|cleaning|tidy|prune|remove|delete|organize)/i.test(text)) return 'cleanup checklist';
  if (/(schedule|itinerary|plan|calendar)/i.test(text)) return 'plan';
  if (/(report|analysis|insight|summary|recap|notes)/i.test(text)) return 'report';
  if (/(invoice|receipt|bill)/i.test(text)) return 'invoice';
  if (/(email|message|dm|reply|slack)/i.test(text)) return 'message';
  return 'task';
}

export function statusEventHint(event: CodexThreadEvent, userPrompt: string): string {
  const base = userPrompt.toLowerCase();
  const fromText = (value: string | undefined): string => {
    const text = `${value ?? ''} ${base}`;
    if (/(ynab|budget|transaction|category)/i.test(text)) return 'checking budget data';
    if (/(shopping|grocery|groceries|list)/i.test(text)) return 'building your list';
    if (/(schedule|calendar|itinerary|plan)/i.test(text)) return 'organizing your schedule';
    if (/(report|analysis|summary|recap)/i.test(text)) return 'preparing your report';
    if (/(invoice|receipt|bill)/i.test(text)) return 'reviewing billing details';
    if (/(email|message|dm|reply|slack)/i.test(text)) return 'preparing your message';
    if (/(meijer|walmart|target|costco)/i.test(text)) return 'checking store items';
    if (/(cleanup|clean up|cleaning|tidy|prune|remove|delete|organize)/i.test(text)) return 'organizing cleanup steps';
    if (/\bdu\b|\bdf\b|\bsize\b|\bbytes\b|\bdisk\b/i.test(text)) return 'checking file sizes';
    if (/\bls\b|\bfind\b|\bgrep\b|\bstat\b/i.test(text)) return 'scanning folders';
    return 'working on your task';
  };

  if (event.type === 'item.started' || event.type === 'item.updated' || event.type === 'item.completed') {
    const item = event.item;
    if (item.type === 'command_execution') {
      return fromText(typeof item.command === 'string' ? item.command : undefined);
    }
    if (item.type === 'web_search') {
      return fromText(typeof item.query === 'string' ? item.query : undefined);
    }
    if (item.type === 'file_change') {
      return 'updating files';
    }
    if (item.type === 'mcp_tool_call') {
      return 'using a helper tool';
    }
    if (item.type === 'reasoning') {
      return 'planning the next step';
    }
    if (item.type === 'agent_message') {
      return 'preparing your response';
    }
    return fromText(undefined);
  }
  if (event.type === 'turn.started') return 'getting started';
  if (event.type === 'turn.completed') return 'finishing up';
  if (event.type === 'thread.started') return 'getting started';
  return 'working on your task';
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
    const text = typeof item.text === 'string' ? item.text : '';
    const cleaned = sanitizeStatusText(text);
    if (cleaned) {
      return cleaned;
    }
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

function sanitizeStatusText(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  const unwrapped = trimmed.replace(/^\*+\s*/, '').replace(/\s*\*+$/, '');
  const squashed = unwrapped.replace(/\s+/g, ' ');
  return truncate(squashed, 120);
}

function formatElapsed(startedAt: number, now: number): string {
  const totalSeconds = Math.max(0, Math.floor((now - startedAt) / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return `${seconds}s`;
  return `${minutes}m ${seconds}s`;
}

function sanitizeForLog(value: unknown, depth = 0): unknown {
  const maxDepth = 3;
  const maxArray = 20;
  const maxKeys = 20;
  const maxString = 500;

  if (depth > maxDepth) return '[truncated]';

  if (typeof value === 'string') {
    if (value.length <= maxString) return value;
    return `${value.slice(0, maxString - 1)}…`;
  }

  if (Array.isArray(value)) {
    const limited = value.slice(0, maxArray).map((item) => sanitizeForLog(item, depth + 1));
    if (value.length > maxArray) {
      return [...limited, `…(${value.length - maxArray} more)`];
    }
    return limited;
  }

  if (value && typeof value === 'object') {
    const entries = Object.entries(value).slice(0, maxKeys);
    const result: Record<string, unknown> = {};
    for (const [key, val] of entries) {
      result[key] = sanitizeForLog(val, depth + 1);
    }
    const totalKeys = Object.keys(value).length;
    if (totalKeys > maxKeys) {
      result._truncated = `…(${totalKeys - maxKeys} more keys)`;
    }
    return result;
  }

  return value;
}
