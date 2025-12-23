import fs from 'node:fs/promises';
import path from 'node:path';
import { extractStructuredOutput, type CodexThread, type CodexThreadEvent } from '../codex/client.js';
import { type BlockKitMessage } from '../blockkit/validator.js';
import { type Logger } from '../logger.js';
import { type SlackClientLike } from './types.js';

export interface FileAttachment {
  path: string;
  filename?: string;
  title?: string;
}

export interface AttachmentResult {
  attempted: boolean;
  succeeded: string[];
  failed: Array<{ filename: string; reason: string }>;
}

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
}): Promise<{ response: { ts?: string }; output: BlockKitMessage; attachments?: AttachmentResult }> {
  const { thread, prompt, outputSchema, logger, threadKey, client, channel, threadTs, workDir, dataDir } = params;
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

    try {
      if (typeof thread.runStreamed === 'function') {
        const stream = await thread.runStreamed(attemptPrompt, { outputSchema });
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
          if (statusText) {
            progress.lastStatus = statusText;
            await maybeUpdateStatus(client, channel, thinkingTs, statusLimiter, statusText);
          }

          if (finalText && sawTurnCompleted) {
            break;
          }
        }
        if (finalText) {
          structuredOutput = extractStructuredOutput({ text: finalText });
        }
      } else {
        const result = await thread.run(attemptPrompt, { outputSchema });
        usage = (result as { usage?: { input_tokens: number; cached_input_tokens: number; output_tokens: number } }).usage ?? null;
        threadId = thread.id ?? null;
        structuredOutput = extractStructuredOutput(result);
      }
    } catch (error) {
      stopProgress();
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
        const { resolved, failures: invalidFailures } = await resolveAttachments(
          requestedAttachments,
          workDir,
          dataDir,
        );
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

async function resolveAttachments(
  attachments: FileAttachment[],
  workDir: string,
  dataDir: string,
): Promise<{ resolved: FileAttachment[]; failures: Array<{ filename: string; reason: string }> }> {
  const resolved: FileAttachment[] = [];
  const failures: Array<{ filename: string; reason: string }> = [];
  const normalizedWorkDir = path.resolve(workDir);
  const normalizedDataDir = path.resolve(dataDir);
  const stagingDir = path.join(normalizedDataDir, 'attachments');
  await fs.mkdir(stagingDir, { recursive: true });

  for (const attachment of attachments) {
    const candidatePath = attachment.path;
    const resolvedPath = path.isAbsolute(candidatePath)
      ? path.resolve(candidatePath)
      : path.resolve(workDir, candidatePath);
    const filename = attachment.filename ?? path.basename(resolvedPath);

    if (isSafePath(resolvedPath, normalizedWorkDir) || isSafePath(resolvedPath, normalizedDataDir)) {
      if (!(await exists(resolvedPath))) {
        failures.push({ filename, reason: 'File not found.' });
        continue;
      }
      resolved.push({ ...attachment, path: resolvedPath, filename });
      continue;
    }

    if (isTempPath(resolvedPath)) {
      if (!(await exists(resolvedPath))) {
        failures.push({ filename, reason: 'Temp file not found.' });
        continue;
      }
      const destination = await ensureUniqueDestination(stagingDir, filename);
      await fs.copyFile(resolvedPath, destination);
      resolved.push({ ...attachment, path: destination, filename: path.basename(destination) });
      continue;
    }

    failures.push({
      filename,
      reason: 'Attachment path must be inside the workspace or data directory.',
    });
  }

  return { resolved, failures };
}

function isSafePath(targetPath: string, workDir: string): boolean {
  const normalizedTarget = path.resolve(targetPath);
  if (!normalizedTarget.startsWith(`${workDir}${path.sep}`) && normalizedTarget !== workDir) {
    return false;
  }
  return true;
}

function isTempPath(targetPath: string): boolean {
  return targetPath.startsWith('/tmp/') || targetPath.startsWith('/var/tmp/');
}

async function ensureUniqueDestination(dir: string, filename: string): Promise<string> {
  const base = path.basename(filename);
  const ext = path.extname(base);
  const stem = ext ? base.slice(0, -ext.length) : base;
  let attempt = 0;
  let candidate = path.join(dir, base);
  while (await exists(candidate)) {
    attempt += 1;
    candidate = path.join(dir, `${stem}-${attempt}${ext}`);
  }
  return candidate;
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.stat(filePath);
    return true;
  } catch {
    return false;
  }
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
