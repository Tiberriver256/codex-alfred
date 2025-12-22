import { type Logger } from '../logger.js';
import { type ThreadStore, type ThreadRecord } from '../store/threadStore.js';
import { buildThreadOptions, type CodexClient } from '../codex/client.js';
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
  blockKitOutputSchema: object;
}

export async function handleAction(
  params: { body: ActionBody; ack: () => Promise<void> },
  deps: ActionDeps,
): Promise<void> {
  const { body, ack } = params;
  const { client, store, codex, config, logger, botUserId, blockKitOutputSchema } = deps;

  await ack();

  const actions = body.actions ?? [];
  const hasSubmit = actions.some((action) => action.type === 'button' || action.action_id?.includes('submit'));
  if (!hasSubmit) {
    logger.info('Ignoring non-submit action', {
      actionTypes: actions.map((action) => action.type ?? 'unknown'),
      actionIds: actions.map((action) => action.action_id ?? 'unknown'),
    });
    return;
  }

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
    const parts = [
      `type=${action.type ?? 'unknown'}`,
      `action_id=${action.action_id ?? 'unknown'}`,
    ];
    if (action.block_id) parts.push(`block_id=${action.block_id}`);
    if (action.value) parts.push(`value=${action.value}`);
    if (action.text?.text) parts.push(`text=${action.text.text}`);
    return `- ${parts.join(' ')}.`;
  });
  const stateLines = formatActionState(body);

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
    'Form state (internal, do not repeat):',
    ...(stateLines.length > 0 ? stateLines : ['- (no state values)']),
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

function formatActionState(body: ActionBody): string[] {
  const values = body.state?.values;
  if (!values || Object.keys(values).length === 0) return [];
  const lines: string[] = [];
  for (const [blockId, actionMap] of Object.entries(values)) {
    for (const [actionId, payload] of Object.entries(actionMap ?? {})) {
      const parts = [
        `block_id=${blockId}`,
        `action_id=${actionId}`,
        `type=${payload?.type ?? 'unknown'}`,
      ];
      const detail = describeStateValue(payload);
      if (detail) parts.push(detail);
      lines.push(`- ${parts.join(' ')}.`);
    }
  }
  return lines;
}

function describeStateValue(payload?: {
  value?: string;
  selected_options?: Array<{ text?: { text?: string }; value?: string }>;
  selected_option?: { text?: { text?: string }; value?: string };
  selected_user?: string;
  selected_users?: string[];
  selected_channel?: string;
  selected_channels?: string[];
  selected_conversation?: string;
  selected_conversations?: string[];
  selected_date?: string;
  selected_time?: string;
}): string | null {
  if (!payload) return null;
  if (payload.selected_options && payload.selected_options.length > 0) {
    return `selected=[${payload.selected_options.map(optionLabel).join(', ')}]`;
  }
  if (payload.selected_option) {
    return `selected=${optionLabel(payload.selected_option)}`;
  }
  if (payload.selected_users && payload.selected_users.length > 0) {
    return `selected_users=[${payload.selected_users.join(', ')}]`;
  }
  if (payload.selected_user) {
    return `selected_user=${payload.selected_user}`;
  }
  if (payload.selected_channels && payload.selected_channels.length > 0) {
    return `selected_channels=[${payload.selected_channels.join(', ')}]`;
  }
  if (payload.selected_channel) {
    return `selected_channel=${payload.selected_channel}`;
  }
  if (payload.selected_conversations && payload.selected_conversations.length > 0) {
    return `selected_conversations=[${payload.selected_conversations.join(', ')}]`;
  }
  if (payload.selected_conversation) {
    return `selected_conversation=${payload.selected_conversation}`;
  }
  if (payload.selected_date) {
    return `selected_date=${payload.selected_date}`;
  }
  if (payload.selected_time) {
    return `selected_time=${payload.selected_time}`;
  }
  if (payload.value !== undefined) {
    return `value=${payload.value}`;
  }
  return null;
}

function optionLabel(option: { text?: { text?: string }; value?: string }): string {
  return option.text?.text ?? option.value ?? 'unknown';
}
