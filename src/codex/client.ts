import { type SandboxConfig } from '../config.js';

export interface CodexRunResult {
  output?: unknown;
  outputText?: string;
  text?: string;
  [key: string]: unknown;
}

export interface CodexThread {
  id: string | null;
  run: (prompt: string, options: { outputSchema: object; signal?: AbortSignal }) => Promise<CodexRunResult>;
  runStreamed?: (prompt: string, options: { outputSchema: object; signal?: AbortSignal }) => Promise<CodexStreamedTurn>;
}

export interface CodexClient {
  startThread: (options: ThreadOptions) => Promise<CodexThread>;
  resumeThread: (id: string, options: ThreadOptions) => Promise<CodexThread>;
}

export type CodexThreadEvent =
  | { type: 'thread.started'; thread_id: string }
  | { type: 'turn.started' }
  | { type: 'turn.completed'; usage: { input_tokens: number; cached_input_tokens: number; output_tokens: number } }
  | { type: 'turn.failed'; error: { message: string } }
  | { type: 'item.started' | 'item.updated' | 'item.completed'; item: { type: string; [key: string]: unknown } }
  | { type: 'error'; message: string };

export interface CodexStreamedTurn {
  events: AsyncGenerator<CodexThreadEvent>;
}

export type ApprovalPolicy = 'never' | 'on-request' | 'on-failure' | 'untrusted';
export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';
export type ModelReasoningEffort = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';

export interface ThreadOptions {
  workingDirectory: string;
  skipGitRepoCheck: boolean;
  approvalPolicy: ApprovalPolicy;
  model?: string;
  sandboxMode?: SandboxMode;
  modelReasoningEffort?: ModelReasoningEffort;
  networkAccessEnabled?: boolean;
  webSearchEnabled?: boolean;
  additionalDirectories?: string[];
}

export async function createCodexClient(): Promise<CodexClient> {
  const mod = (await import('@openai/codex-sdk')) as { Codex?: new (opts?: unknown) => unknown; default?: new () => unknown };
  const CodexCtor = mod.Codex ?? mod.default;
  if (!CodexCtor) {
    throw new Error('Unable to load Codex SDK.');
  }

  const client = new (CodexCtor as new () => any)();

  return {
    startThread: async (options) => {
      if (typeof client.startThread !== 'function') {
        throw new Error('Codex SDK missing startThread().');
      }
      return client.startThread(options);
    },
    resumeThread: async (id, options) => {
      if (typeof client.resumeThread === 'function') {
        return client.resumeThread(id, options);
      }
      if (typeof client.getThread === 'function') {
        return client.getThread(id, options);
      }
      if (client.threads?.retrieve) {
        return client.threads.retrieve(id, options);
      }
      if (typeof client.thread === 'function') {
        return client.thread(id, options);
      }
      throw new Error('Codex SDK missing resumeThread() method.');
    },
  };
}

export function buildThreadOptions(
  workDir: string,
  sandbox: SandboxConfig,
  cliArgs: string[],
): ThreadOptions {
  const parsed = parseCodexArgs(cliArgs);

  return {
    workingDirectory: workDir,
    skipGitRepoCheck: true,
    approvalPolicy: 'never',
    ...parsed,
  };
}

export function extractStructuredOutput(result: CodexRunResult): unknown {
  if (result.output !== undefined) return result.output;
  if (typeof result.outputText === 'string') {
    return safeJsonParse(result.outputText);
  }
  if (typeof result.text === 'string') {
    return safeJsonParse(result.text);
  }
  if (typeof (result as { finalResponse?: unknown }).finalResponse === 'string') {
    return safeJsonParse((result as { finalResponse: string }).finalResponse);
  }
  return result;
}

function parseCodexArgs(args: string[]): Partial<ThreadOptions> {
  const result: Partial<ThreadOptions> = {};
  const additionalDirectories: string[] = [];

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];

    if (arg === '--yolo' || arg === '--dangerously-bypass-approvals-and-sandbox') {
      result.sandboxMode = 'danger-full-access';
      result.approvalPolicy = 'never';
      continue;
    }

    if (arg === '--model' || arg === '-m') {
      const value = args[i + 1];
      if (value) {
        result.model = value;
        i += 1;
      }
      continue;
    }

    if (arg.startsWith('--model=')) {
      result.model = arg.slice('--model='.length);
      continue;
    }

    if (arg === '--sandbox' || arg === '-s') {
      const value = args[i + 1];
      if (value) {
        result.sandboxMode = value as SandboxMode;
        i += 1;
      }
      continue;
    }

    if (arg.startsWith('--sandbox=')) {
      result.sandboxMode = arg.slice('--sandbox='.length) as SandboxMode;
      continue;
    }

    if (arg === '--add-dir') {
      const value = args[i + 1];
      if (value) {
        additionalDirectories.push(value);
        i += 1;
      }
      continue;
    }

    if (arg.startsWith('--add-dir=')) {
      additionalDirectories.push(arg.slice('--add-dir='.length));
      continue;
    }

    if (arg === '--config') {
      const value = args[i + 1];
      if (value) {
        applyConfigValue(value, result);
        i += 1;
      }
      continue;
    }

    if (arg.startsWith('--config=')) {
      applyConfigValue(arg.slice('--config='.length), result);
      continue;
    }
  }

  if (additionalDirectories.length) {
    result.additionalDirectories = additionalDirectories;
  }

  return result;
}

function applyConfigValue(value: string, result: Partial<ThreadOptions>): void {
  const [rawKey, rawVal] = value.split('=', 2);
  if (!rawKey) return;

  const key = rawKey.trim();
  const cleanedValue = (rawVal ?? '').trim().replace(/^["']|["']$/g, '');

  if (!cleanedValue) return;

  if (key === 'model_reasoning_effort') {
    result.modelReasoningEffort = cleanedValue as ModelReasoningEffort;
    return;
  }

  if (key === 'approval_policy') {
    result.approvalPolicy = cleanedValue as ApprovalPolicy;
    return;
  }

  if (key === 'sandbox_workspace_write.network_access') {
    result.networkAccessEnabled = cleanedValue === 'true';
    return;
  }

  if (key === 'features.web_search_request') {
    result.webSearchEnabled = cleanedValue === 'true';
  }
}

function safeJsonParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}
