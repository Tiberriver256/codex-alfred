import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { type SandboxConfig } from '../config.js';

export interface FileAttachment {
  path: string;
  filename?: string;
  title?: string;
}

export interface ResolvedAttachments {
  resolved: FileAttachment[];
  failures: Array<{ filename: string; reason: string }>;
  cleanup: string[];
}

export interface AttachmentResolutionOptions {
  workDir: string;
  dataDir: string;
  sandbox: SandboxConfig;
}

export interface AttachmentResolutionDeps {
  dockerCopy?: (container: string, sourcePath: string, destinationPath: string) => void;
  isGitRepo?: (dir: string) => Promise<boolean>;
}

export async function resolveAttachments(
  attachments: FileAttachment[],
  options: AttachmentResolutionOptions,
  deps: AttachmentResolutionDeps = {},
): Promise<ResolvedAttachments> {
  const resolved: FileAttachment[] = [];
  const failures: Array<{ filename: string; reason: string }> = [];
  const cleanup: string[] = [];
  const normalizedWorkDir = path.resolve(options.workDir);
  const normalizedDataDir = path.resolve(options.dataDir);
  const containerName = options.sandbox.mode === 'docker' ? options.sandbox.name : null;

  const isGitRepo = deps.isGitRepo ?? isGitRepoDir;
  const useTempStaging = (await isGitRepo(normalizedDataDir)) || options.sandbox.mode === 'docker';
  const stagingRoot = useTempStaging
    ? path.join(os.tmpdir(), 'alfred-attachments')
    : path.join(normalizedDataDir, 'attachments');
  await fs.mkdir(stagingRoot, { recursive: true });

  for (const attachment of attachments) {
    const candidatePath = attachment.path;
    const normalizedCandidate = normalizeAttachmentPath(candidatePath, normalizedWorkDir);
    const filename = attachment.filename ?? path.basename(normalizedCandidate);

    const hostPath =
      options.sandbox.mode === 'docker'
        ? mapContainerWorkspaceToHost(normalizedCandidate, normalizedDataDir)
        : normalizedCandidate;

    if (hostPath && (isSafePath(hostPath, normalizedWorkDir) || isSafePath(hostPath, normalizedDataDir))) {
      if (!(await exists(hostPath))) {
        failures.push({ filename, reason: 'File not found.' });
        continue;
      }
      resolved.push({ ...attachment, path: hostPath, filename });
      continue;
    }

    if (options.sandbox.mode === 'host' && isTempPath(normalizedCandidate)) {
      if (!(await exists(normalizedCandidate))) {
        failures.push({ filename, reason: 'Temp file not found.' });
        continue;
      }
      const destination = await ensureUniqueDestination(stagingRoot, filename);
      await fs.copyFile(normalizedCandidate, destination);
      cleanup.push(destination);
      resolved.push({ ...attachment, path: destination, filename: path.basename(destination) });
      continue;
    }

    if (options.sandbox.mode === 'docker' && containerName) {
      const containerPath = normalizeContainerPath(candidatePath);
      const destination = await ensureUniqueDestination(stagingRoot, filename);
      try {
        const dockerCopy = deps.dockerCopy ?? defaultDockerCopy;
        dockerCopy(containerName, containerPath, destination);
      } catch (error) {
        failures.push({ filename, reason: formatCopyError(error) });
        continue;
      }
      cleanup.push(destination);
      resolved.push({ ...attachment, path: destination, filename: path.basename(destination) });
      continue;
    }

    failures.push({
      filename,
      reason: 'Attachment path must be inside the workspace or data directory.',
    });
  }

  return { resolved, failures, cleanup };
}

export async function cleanupAttachments(paths: string[]): Promise<void> {
  await Promise.all(
    paths.map(async (filePath) => {
      try {
        await fs.unlink(filePath);
      } catch {
        return;
      }
    }),
  );
}

function normalizeAttachmentPath(candidatePath: string, workDir: string): string {
  if (path.isAbsolute(candidatePath)) {
    return path.resolve(candidatePath);
  }
  return path.resolve(workDir, candidatePath);
}

function normalizeContainerPath(candidatePath: string): string {
  if (path.isAbsolute(candidatePath)) {
    return path.posix.normalize(candidatePath);
  }
  return path.posix.join('/workspace', candidatePath);
}

function mapContainerWorkspaceToHost(candidatePath: string, dataDir: string): string | null {
  const normalized = path.posix.normalize(candidatePath);
  if (!normalized.startsWith('/workspace')) return null;
  const relative = normalized === '/workspace' ? '' : normalized.replace('/workspace/', '');
  return path.resolve(dataDir, relative);
}

function isTempPath(candidatePath: string): boolean {
  return candidatePath.startsWith('/tmp/') || candidatePath.startsWith('/var/tmp/');
}

function isSafePath(targetPath: string, root: string): boolean {
  const normalizedTarget = path.resolve(targetPath);
  const normalizedRoot = path.resolve(root);
  if (!normalizedTarget.startsWith(`${normalizedRoot}${path.sep}`) && normalizedTarget !== normalizedRoot) {
    return false;
  }
  return true;
}

async function ensureUniqueDestination(dir: string, filename: string): Promise<string> {
  const base = path.basename(filename);
  const ext = path.extname(base);
  const stem = ext ? base.slice(0, -ext.length) : base;
  let attempt = 0;
  let candidate = path.join(dir, base);
  while (await exists(candidate)) {
    attempt += 1;
    candidate = path.join(dir, `${stem}-${attempt}${ext}`);
  }
  return candidate;
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.stat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function isGitRepoDir(dir: string): Promise<boolean> {
  try {
    const stat = await fs.stat(path.join(dir, '.git'));
    return stat.isDirectory();
  } catch {
    return false;
  }
}

function defaultDockerCopy(container: string, sourcePath: string, destinationPath: string): void {
  execFileSync('docker', ['cp', `${container}:${sourcePath}`, destinationPath], {
    stdio: 'pipe',
  });
}

function formatCopyError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return 'Failed to copy file from Docker container.';
}
