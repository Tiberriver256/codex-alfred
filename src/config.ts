import path from 'node:path';

export type SandboxConfig =
  | { mode: 'host' }
  | { mode: 'docker'; name: string };

export interface AppConfig {
  appToken: string;
  botToken: string;
  dataDir: string;
  workDir: string;
  sandbox: SandboxConfig;
  codexArgs: string[];
  logLevel: 'debug' | 'info' | 'warn' | 'error';
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

  const finalCodexArgs = sandbox.mode === 'docker' && !codexArgs.includes('--yolo')
    ? ['--yolo', ...codexArgs]
    : codexArgs;

  return {
    config: {
      appToken,
      botToken,
      dataDir,
      workDir,
      sandbox,
      codexArgs: finalCodexArgs,
      logLevel,
    },
    showHelp: false,
    showVersion: false,
  };
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
  --help                 Show this help
  --version              Show version

Env:
  SLACK_APP_TOKEN, SLACK_BOT_TOKEN, ALFRED_DATA_DIR, ALFRED_WORKDIR, ALFRED_SANDBOX, ALFRED_LOG_LEVEL
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
