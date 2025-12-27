export interface SlackClientLike {
  conversations: {
    replies: (args: { channel: string; ts: string; oldest?: string }) => Promise<{ messages?: SlackMessage[] }>;
    history?: (args: {
      channel: string;
      oldest?: string;
      limit?: number;
      cursor?: string;
    }) => Promise<{ messages?: SlackMessage[]; response_metadata?: { next_cursor?: string } }>;
    list?: (args: {
      types?: string;
      limit?: number;
      cursor?: string;
      exclude_archived?: boolean;
    }) => Promise<{ channels?: SlackConversation[]; response_metadata?: { next_cursor?: string } }>;
  };
  chat: {
    postMessage: (args: { channel: string; thread_ts: string; text: string; blocks: unknown[] }) => Promise<{ ts?: string }>;
    update: (args: { channel: string; ts: string; text: string; blocks: unknown[] }) => Promise<{ ts?: string }>;
    delete?: (args: { channel: string; ts: string }) => Promise<void>;
  };
  files?: {
    upload?: (args: {
      channels: string;
      thread_ts?: string;
      filename?: string;
      file: Buffer | Uint8Array | string;
      initial_comment?: string;
    }) => Promise<{ file?: { id?: string } }>;
    uploadV2?: (args: {
      channel_id: string;
      thread_ts?: string;
      initial_comment?: string;
      file: Buffer | Uint8Array | string;
      filename?: string;
      title?: string;
    }) => Promise<{ files?: Array<{ id?: string }> }>;
  };
}

export interface SlackMessage {
  ts?: string;
  text?: string;
  user?: string;
  subtype?: string;
  bot_id?: string;
  files?: SlackFile[];
  thread_ts?: string;
  reply_count?: number;
  latest_reply?: string;
}

export interface SlackConversation {
  id?: string;
  is_member?: boolean;
}

export interface SlackFile {
  id?: string;
  name?: string;
  title?: string;
  mimetype?: string;
  filetype?: string;
  url_private?: string;
  url_private_download?: string;
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
    type?: string;
    action_id?: string;
    block_id?: string;
    value?: string;
    text?: { text?: string };
  }>;
  state?: {
    values?: Record<
      string,
      Record<
        string,
        {
          type?: string;
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
        }
      >
    >;
  };
}
