import path from 'node:path';

export type SandboxConfig =
  | { mode: 'host' }
  | { mode: 'docker'; name: string };

export interface VoiceConfig {
  enabled: boolean;
  elevenlabs?: {
    apiKey: string;
    voiceId: string;
    model?: string;
  };
}

export interface AppConfig {
  appToken: string;
  botToken: string;
  dataDir: string;
  workDir: string;
  sandbox: SandboxConfig;
  codexArgs: string[];
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  mentionBackfill: MentionBackfillConfig;
  voice: VoiceConfig;
}

export interface MentionBackfillConfig {
  enabled: boolean;
  intervalMs: number;
  historyLookbackSeconds: number;
  maxHistoryPages: number;
  minAgeSeconds: number;
}

export interface CliParseResult {
  config: AppConfig | null;
  showHelp: boolean;
  showVersion: boolean;
}

export function parseCli(argv: string[], env = process.env, cwd = process.cwd()): CliParseResult {
  const args = argv.slice(2);
  const splitIndex = args.indexOf('--');
  const mainArgs = splitIndex === -1 ? args : args.slice(0, splitIndex);
  const codexArgs = splitIndex === -1 ? [] : args.slice(splitIndex + 1);

  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < mainArgs.length; i += 1) {
    const arg = mainArgs[i];
    if (!arg.startsWith('--')) continue;

    const [key, inlineValue] = arg.slice(2).split('=');
    if (inlineValue !== undefined) {
      flags[key] = inlineValue;
      continue;
    }

    if (key === 'help' || key === 'version') {
      flags[key] = true;
      continue;
    }

    const next = mainArgs[i + 1];
    if (!next || next.startsWith('--')) {
      throw new Error(`Missing value for --${key}`);
    }
    flags[key] = next;
    i += 1;
  }

  if (flags.help) {
    return { config: null, showHelp: true, showVersion: false };
  }

  if (flags.version) {
    return { config: null, showHelp: false, showVersion: true };
  }

  const appToken = (flags.appKey as string) ?? env.SLACK_APP_TOKEN;
  const botToken = (flags.botKey as string) ?? env.SLACK_BOT_TOKEN;

  if (!appToken || !botToken) {
    throw new Error('Missing Slack tokens. Provide --appKey/--botKey or set SLACK_APP_TOKEN/SLACK_BOT_TOKEN.');
  }

  const dataDirRaw = (flags['data-dir'] as string) ?? env.ALFRED_DATA_DIR ?? path.join(cwd, 'data');
  const dataDir = path.resolve(cwd, dataDirRaw);

  const sandboxRaw = (flags.sandbox as string) ?? env.ALFRED_SANDBOX ?? 'host';
  const sandbox = parseSandbox(sandboxRaw);

  const workDirRaw = (flags.workdir as string) ?? env.ALFRED_WORKDIR;
  const workDir = workDirRaw
    ? path.resolve(cwd, workDirRaw)
    : sandbox.mode === 'docker'
      ? '/workspace'
      : dataDir;

  const logLevel = (flags['log-level'] as AppConfig['logLevel']) ?? (env.ALFRED_LOG_LEVEL as AppConfig['logLevel']) ?? 'info';
  const mentionBackfillEnabled = parseBoolean(
    (flags['mention-backfill'] as string) ?? env.ALFRED_MENTION_BACKFILL,
    true,
  );
  const mentionBackfillIntervalSeconds = parsePositiveInt(
    (flags['mention-backfill-interval'] as string) ?? env.ALFRED_MENTION_BACKFILL_INTERVAL,
    60,
  );
  const mentionBackfillLookbackSeconds = parsePositiveInt(
    (flags['mention-backfill-lookback'] as string) ?? env.ALFRED_MENTION_BACKFILL_LOOKBACK,
    86400,
  );
  const mentionBackfillMaxPages = parsePositiveInt(
    (flags['mention-backfill-max-pages'] as string) ?? env.ALFRED_MENTION_BACKFILL_MAX_PAGES,
    3,
  );
  const mentionBackfillMinAgeSeconds = parsePositiveInt(
    (flags['mention-backfill-min-age'] as string) ?? env.ALFRED_MENTION_BACKFILL_MIN_AGE,
    60,
  );

  const voiceEnabled = parseBoolean(
    (flags['voice-enabled'] as string) ?? env.ALFRED_VOICE_ENABLED,
    false,
  );
  const elevenLabsApiKey = (flags['elevenlabs-api-key'] as string) ?? env.ELEVENLABS_API_KEY;
  const elevenLabsVoiceId = (flags['elevenlabs-voice-id'] as string) ?? env.ELEVENLABS_VOICE_ID;
  const elevenLabsModel = (flags['elevenlabs-model'] as string) ?? env.ELEVENLABS_MODEL;

  const withDefaults = applyCodexDefaults(codexArgs);
  const finalCodexArgs = sandbox.mode === 'docker' && !withDefaults.includes('--yolo')
    ? ['--yolo', ...withDefaults]
    : withDefaults;

  return {
    config: {
      appToken,
      botToken,
      dataDir,
      workDir,
      sandbox,
      codexArgs: finalCodexArgs,
      logLevel,
      mentionBackfill: {
        enabled: mentionBackfillEnabled,
        intervalMs: mentionBackfillIntervalSeconds * 1000,
        historyLookbackSeconds: mentionBackfillLookbackSeconds,
        maxHistoryPages: mentionBackfillMaxPages,
        minAgeSeconds: mentionBackfillMinAgeSeconds,
      },
      voice: {
        enabled: voiceEnabled,
        elevenlabs: elevenLabsApiKey && elevenLabsVoiceId
          ? {
              apiKey: elevenLabsApiKey,
              voiceId: elevenLabsVoiceId,
              model: elevenLabsModel,
            }
          : undefined,
      },
    },
    showHelp: false,
    showVersion: false,
  };
}

function applyCodexDefaults(args: string[]): string[] {
  const next = [...args];
  const hasModel = hasFlag(next, '--model') || hasFlag(next, '-m');
  if (!hasModel) {
    next.push('--model', 'gpt-5.2-codex');
  }

  const hasReasoning = hasConfig(next, 'model_reasoning_effort');
  if (!hasReasoning) {
    next.push('--config', 'model_reasoning_effort="high"');
  }
  return next;
}

function hasFlag(args: string[], flag: string): boolean {
  if (args.includes(flag)) return true;
  return args.some((arg) => arg.startsWith(`${flag}=`));
}

function hasConfig(args: string[], key: string): boolean {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--config') {
      const value = args[i + 1] ?? '';
      if (value.includes(key)) return true;
    }
    if (arg.startsWith('--config=')) {
      if (arg.includes(key)) return true;
    }
  }
  return false;
}

export function formatHelp(): string {
  return `Usage: codex-alfred [options] [-- <codex args>]

Options:
  --appKey <token>       Slack app-level token (xapp-...)
  --botKey <token>       Slack bot token (xoxb-...)
  --data-dir <path>      Data directory (default: ./data)
  --workdir <path>       Codex working directory (default: data dir or /workspace for docker)
  --sandbox <mode>       host | docker:<name>
  --log-level <level>    debug | info | warn | error
  --mention-backfill <bool>        Enable mention backfill poller (default: true)
  --mention-backfill-interval <s>  Backfill poll interval in seconds (default: 60)
  --mention-backfill-lookback <s>  History lookback window in seconds (default: 86400)
  --mention-backfill-max-pages <n> Max history/list pages per poll (default: 3)
  --mention-backfill-min-age <s>   Only handle mentions older than N seconds (default: 60)
  --voice-enabled <bool>           Enable voice features (default: false)
  --elevenlabs-api-key <key>       ElevenLabs API key
  --elevenlabs-voice-id <id>       ElevenLabs voice ID
  --elevenlabs-model <model>       ElevenLabs model (optional)
  --help                 Show this help
  --version              Show version

Env:
  SLACK_APP_TOKEN, SLACK_BOT_TOKEN, ALFRED_DATA_DIR, ALFRED_WORKDIR, ALFRED_SANDBOX, ALFRED_LOG_LEVEL
  ALFRED_MENTION_BACKFILL, ALFRED_MENTION_BACKFILL_INTERVAL, ALFRED_MENTION_BACKFILL_LOOKBACK,
  ALFRED_MENTION_BACKFILL_MAX_PAGES, ALFRED_MENTION_BACKFILL_MIN_AGE
  ALFRED_VOICE_ENABLED, ELEVENLABS_API_KEY, ELEVENLABS_VOICE_ID, ELEVENLABS_MODEL
`;
}

function parseSandbox(value: string): SandboxConfig {
  if (value === 'host') return { mode: 'host' };
  if (value.startsWith('docker:')) {
    const name = value.slice('docker:'.length);
    if (!name) throw new Error('Sandbox docker mode requires a container name (docker:<name>).');
    return { mode: 'docker', name };
  }
  throw new Error(`Invalid sandbox value: ${value}`);
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (!value) return fallback;
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false;
  return fallback;
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed) || parsed <= 0) return fallback;
  return parsed;
}
