import { type Logger } from '../logger.js';
import { type ThreadStore } from '../store/threadStore.js';
import { type SlackClientLike, type SlackConversation, type SlackMessage, type MentionEvent } from './types.js';
import { handleAppMention, type MentionDeps } from './mentionHandler.js';

export interface MentionBackfillOptions {
  historyLookbackSeconds: number;
  maxHistoryPages: number;
  minAgeSeconds: number;
  now?: () => number;
}

export interface MentionBackfillScheduleOptions extends MentionBackfillOptions {
  intervalMs: number;
}

export interface MentionBackfillState {
  lastPollTs: string;
}

export interface MentionBackfillDeps {
  client: SlackClientLike;
  store: ThreadStore;
  logger: Logger;
  botUserId: string;
}

export function startMentionBackfillPoller(
  deps: MentionDeps,
  options: MentionBackfillScheduleOptions,
): { stop: () => void; state: MentionBackfillState } {
  const state: MentionBackfillState = { lastPollTs: `${currentTs(options)}` };
  const runOnce = async () => {
    const mentions = await collectMissedMentions(
      { client: deps.client, store: deps.store, logger: deps.logger, botUserId: deps.botUserId },
      state,
      options,
    );
    for (const event of mentions) {
      await handleAppMention({ event, ack: async () => undefined }, deps);
    }
  };
  const interval = setInterval(() => void runOnce(), options.intervalMs);
  void runOnce();
  return {
    stop: () => clearInterval(interval),
    state,
  };
}

export async function collectMissedMentions(
  deps: MentionBackfillDeps,
  state: MentionBackfillState,
  options: MentionBackfillOptions,
): Promise<MentionEvent[]> {
  const { client, store, logger, botUserId } = deps;
  const list = client.conversations.list;
  const history = client.conversations.history;
  if (!list || !history) {
    logger.warn('Mention backfill skipped: Slack client missing conversations.list or conversations.history');
    return [];
  }

  const pollStartedAt = currentTs(options);
  const lastPollTs = Number(state.lastPollTs ?? 0);
  const minAgeSeconds = Math.max(options.minAgeSeconds, 0);
  const eligibleNewest = pollStartedAt - minAgeSeconds;
  const historyLookback = Math.max(options.historyLookbackSeconds, 0);
  const historyOldest = Math.min(
    lastPollTs || pollStartedAt,
    pollStartedAt - historyLookback,
  );

  const channels = await listMemberChannels(client, logger, options.maxHistoryPages);
  const mentions: MentionEvent[] = [];
  const seen = new Set<string>();

  for (const channel of channels) {
    const channelId = channel.id;
    if (!channelId) continue;
    const messages = await fetchHistory(
      client,
      channelId,
      historyOldest,
      options.maxHistoryPages,
      logger,
    );

    for (const message of messages) {
      const messageTs = toTsNumber(message.ts);
      if (!messageTs) continue;
      if (messageTs > lastPollTs && messageTs <= eligibleNewest && isMentionCandidate(message, botUserId)) {
        const event = messageToMentionEvent(channelId, message);
        if (event && !isDuplicate(event, seen) && !isAlreadyHandled(store, event)) {
          (event as MentionEvent & { source?: string }).source = 'backfill';
          mentions.push(event);
        }
      }

      const latestReplyTs = toTsNumber(message.latest_reply);
      if (!latestReplyTs || latestReplyTs <= lastPollTs || !message.ts) continue;
      const replies = await fetchReplies(client, channelId, message.ts, state.lastPollTs, logger);
      for (const reply of replies) {
        const replyTs = toTsNumber(reply.ts);
        if (!replyTs || replyTs <= lastPollTs || replyTs > eligibleNewest) continue;
        if (!isMentionCandidate(reply, botUserId)) continue;
        const event = messageToMentionEvent(channelId, reply);
        if (event && !isDuplicate(event, seen) && !isAlreadyHandled(store, event)) {
          (event as MentionEvent & { source?: string }).source = 'backfill';
          mentions.push(event);
        }
      }
    }
  }

  state.lastPollTs = `${Math.max(lastPollTs, eligibleNewest)}`;
  mentions.sort((a, b) => Number(a.ts) - Number(b.ts));
  return mentions;
}

function currentTs(options: MentionBackfillOptions): number {
  const now = options.now ?? (() => Date.now() / 1000);
  return Math.floor(now());
}

async function listMemberChannels(
  client: SlackClientLike,
  logger: Logger,
  maxPages: number,
): Promise<SlackConversation[]> {
  const channels: SlackConversation[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < maxPages; page += 1) {
    try {
      const res = await client.conversations.list?.({
        limit: 200,
        types: 'public_channel,private_channel,im,mpim',
        exclude_archived: true,
        cursor,
      });
      const batch = res?.channels ?? [];
      for (const channel of batch) {
        if (!channel.id) continue;
        if (channel.is_member === false) continue;
        channels.push(channel);
      }
      const next = res?.response_metadata?.next_cursor;
      if (!next) break;
      cursor = next;
    } catch (error) {
      logger.warn('Failed to list Slack conversations for mention backfill', error);
      break;
    }
  }
  return channels;
}

async function fetchHistory(
  client: SlackClientLike,
  channel: string,
  oldest: number,
  maxPages: number,
  logger: Logger,
): Promise<SlackMessage[]> {
  const messages: SlackMessage[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < maxPages; page += 1) {
    try {
      const res = await client.conversations.history?.({
        channel,
        oldest: `${oldest}`,
        limit: 200,
        cursor,
      });
      messages.push(...(res?.messages ?? []));
      const next = res?.response_metadata?.next_cursor;
      if (!next) break;
      cursor = next;
    } catch (error) {
      logger.warn('Failed to fetch Slack history for mention backfill', { channel, error });
      break;
    }
  }
  return messages;
}

async function fetchReplies(
  client: SlackClientLike,
  channel: string,
  threadTs: string,
  oldest: string,
  logger: Logger,
): Promise<SlackMessage[]> {
  try {
    const res = await client.conversations.replies({
      channel,
      ts: threadTs,
      oldest,
    });
    return res.messages ?? [];
  } catch (error) {
    logger.warn('Failed to fetch Slack replies for mention backfill', { channel, threadTs, error });
    return [];
  }
}

function isMentionCandidate(message: SlackMessage, botUserId: string): boolean {
  if (!message.text) return false;
  if (!isUserMessage(message, botUserId)) return false;
  return message.text.includes(`<@${botUserId}>`);
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

function messageToMentionEvent(channel: string, message: SlackMessage): MentionEvent | null {
  if (!message.ts) return null;
  return {
    channel,
    ts: message.ts,
    thread_ts: message.thread_ts ?? message.ts,
    text: message.text,
    user: message.user,
  };
}

function isAlreadyHandled(store: ThreadStore, event: MentionEvent): boolean {
  const threadKey = `${event.channel}:${event.thread_ts ?? event.ts}`;
  const record = store.get(threadKey);
  if (!record) return false;
  const seen = toTsNumber(record.lastSeenUserTs ?? record.lastResponseTs);
  const eventTs = toTsNumber(event.ts);
  if (!seen || !eventTs) return false;
  return eventTs <= seen;
}

function toTsNumber(value?: string): number | null {
  if (!value) return null;
  const parsed = Number(value);
  if (Number.isNaN(parsed)) return null;
  return parsed;
}

function isDuplicate(event: MentionEvent, seen: Set<string>): boolean {
  const key = `${event.channel}:${event.ts}`;
  if (seen.has(key)) return true;
  seen.add(key);
  return false;
}
