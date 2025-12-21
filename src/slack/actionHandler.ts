import { type Logger } from '../logger.js';
import { type ThreadStore, type ThreadRecord } from '../store/threadStore.js';
import { buildThreadOptions, type CodexClient } from '../codex/client.js';
import { type BlockKitValidationResult } from '../blockkit/validator.js';
import { type AppConfig } from '../config.js';
import { runCodexAndPost } from './codexResponder.js';
import { type SlackClientLike, type ActionBody } from './types.js';

export interface ActionDeps {
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

export async function handleAction(
  params: { body: ActionBody; ack: () => Promise<void> },
  deps: ActionDeps,
): Promise<void> {
  const { body, ack } = params;
  const { client, store, codex, config, logger, botUserId, validateBlockKit, blockKitOutputSchema } = deps;

  await ack();

  const channel = body.channel?.id ?? body.container?.channel_id;
  const threadTs = body.message?.thread_ts ?? body.container?.thread_ts ?? body.message?.ts ?? body.container?.message_ts;

  if (!channel || !threadTs) {
    logger.warn('Action payload missing channel or thread timestamp.');
    return;
  }

  const threadKey = `${channel}:${threadTs}`;
  const record = store.get(threadKey);
  const threadOptions = buildThreadOptions(config.workDir, config.sandbox, config.codexArgs);

  const thread = record?.codexThreadId
    ? await codex.resumeThread(record.codexThreadId, threadOptions)
    : await codex.startThread(threadOptions);

  const replies = await client.conversations.replies({
    channel,
    ts: threadTs,
    oldest: record?.lastResponseTs,
  });

  const prompt = buildActionPrompt({
    channel,
    threadTs,
    body,
    botUserId,
    messages: replies.messages ?? [],
  });

  const { response } = await runCodexAndPost({
    thread,
    prompt,
    outputSchema: blockKitOutputSchema,
    validateBlockKit,
    logger,
    threadKey,
    client,
    channel,
    threadTs,
  });

  const lastResponseTs = response.ts ?? record?.lastResponseTs ?? threadTs;
  const lastSeenUserTs = extractLastSeenUserTs(replies.messages ?? [], record?.lastSeenUserTs);
  const threadId = thread.id ?? record?.codexThreadId;
  const patch: Partial<ThreadRecord> = { lastResponseTs, lastSeenUserTs };
  if (threadId) patch.codexThreadId = threadId;

  if (record) {
    await store.update(threadKey, patch);
  } else {
    await store.set({ threadKey, ...patch });
  }

  logger.info(`Handled action for ${threadKey}`);
}

function buildActionPrompt(params: {
  channel: string;
  threadTs: string;
  body: ActionBody;
  botUserId: string;
  messages: { ts?: string; text?: string; user?: string }[];
}): string {
  const { channel, threadTs, body, botUserId, messages } = params;
  const actions = (body.actions ?? []).map((action) => {
    const parts = [`action_id=${action.action_id ?? 'unknown'}`];
    if (action.block_id) parts.push(`block_id=${action.block_id}`);
    if (action.value) parts.push(`value=${action.value}`);
    if (action.text?.text) parts.push(`text=${action.text.text}`);
    return `- ${parts.join(' ')}.`;
  });

  const lines = messages
    .filter((msg) => msg.user && msg.user !== botUserId)
    .map((msg) => `- [${msg.ts ?? 'unknown'}] @${msg.user}: ${stripBotMention(msg.text ?? '', botUserId)}`);

  if (lines.length === 0) {
    lines.push('- (no new messages)');
  }

  return [
    'Action payload (internal, do not repeat):',
    ...(actions.length > 0 ? actions : ['- (no actions)']),
    '',
    'Messages since last response:',
    ...lines,
    '',
    'Respond with Block Kit JSON that matches the output schema.',
  ].join('\n');
}

function stripBotMention(text: string, botUserId: string): string {
  const mention = new RegExp(`<@${botUserId}>`, 'g');
  return text.replace(mention, '').trim();
}

function extractLastSeenUserTs(
  messages: { ts?: string; user?: string; subtype?: string; bot_id?: string }[],
  fallback?: string,
): string | undefined {
  const userMessages = messages.filter((msg) => !msg.subtype && msg.user && !msg.bot_id);
  if (userMessages.length === 0) return fallback;
  return userMessages[userMessages.length - 1].ts ?? fallback;
}
