import fs from 'node:fs/promises';
import path from 'node:path';

export interface ThreadRecord {
  threadKey: string;
  codexThreadId?: string;
  lastResponseTs?: string;
  lastSeenUserTs?: string;
  pendingAttachment?: PendingAttachment;
}

export interface PendingAttachment {
  path: string;
  filename?: string;
  title?: string;
}

interface ThreadStoreFile {
  version: number;
  threads: Record<string, ThreadRecord>;
}

export class ThreadStore {
  private readonly filePath: string;
  private readonly threads = new Map<string, ThreadRecord>();

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  async load(): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    try {
      const raw = await fs.readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as ThreadStoreFile;
      if (!parsed || typeof parsed !== 'object' || !parsed.threads) return;
      for (const [key, value] of Object.entries(parsed.threads)) {
        this.threads.set(key, value);
      }
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code === 'ENOENT') return;
      const backupPath = `${this.filePath}.corrupt-${Date.now()}`;
      await fs.rename(this.filePath, backupPath).catch(() => undefined);
      this.threads.clear();
    }
  }

  get(threadKey: string): ThreadRecord | undefined {
    return this.threads.get(threadKey);
  }

  async set(record: ThreadRecord): Promise<void> {
    this.threads.set(record.threadKey, record);
    await this.persist();
  }

  async update(threadKey: string, patch: Partial<ThreadRecord>): Promise<ThreadRecord> {
    const current = this.threads.get(threadKey);
    if (!current) {
      throw new Error(`Thread record not found: ${threadKey}`);
    }
    const updated = { ...current, ...patch };
    this.threads.set(threadKey, updated);
    await this.persist();
    return updated;
  }

  private async persist(): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const payload: ThreadStoreFile = {
      version: 1,
      threads: Object.fromEntries(this.threads.entries()),
    };
    const tempPath = `${this.filePath}.tmp`;
    await fs.writeFile(tempPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    await fs.rename(tempPath, this.filePath);
  }
}
