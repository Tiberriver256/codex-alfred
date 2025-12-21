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

export interface ActionBody {
  user?: { id?: string };
  channel?: { id?: string };
  container?: {
    channel_id?: string;
    thread_ts?: string;
    message_ts?: string;
  };
  message?: {
    ts?: string;
    thread_ts?: string;
    text?: string;
    blocks?: unknown[];
  };
  actions?: Array<{
    action_id?: string;
    block_id?: string;
    value?: string;
    text?: { text?: string };
  }>;
}
