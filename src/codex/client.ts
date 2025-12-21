import { type SandboxConfig } from '../config.js';

export interface CodexRunResult {
  output?: unknown;
  outputText?: string;
  text?: string;
  [key: string]: unknown;
}

export interface CodexThread {
  id: string | null;
  run: (prompt: string, options: { outputSchema: object }) => Promise<CodexRunResult>;
}

export interface CodexClient {
  startThread: (options: ThreadOptions) => Promise<CodexThread>;
  resumeThread: (id: string, options: ThreadOptions) => Promise<CodexThread>;
}

export interface ThreadOptions {
  workingDirectory: string;
  skipGitRepoCheck: boolean;
  approvalPolicy: 'never';
  sandbox?: SandboxConfig;
  cliArgs?: string[];
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
  return {
    workingDirectory: workDir,
    skipGitRepoCheck: true,
    approvalPolicy: 'never',
    sandbox,
    cliArgs,
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

function safeJsonParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}
