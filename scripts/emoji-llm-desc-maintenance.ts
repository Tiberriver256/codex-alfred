import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

const SAMPLE_LIMIT = Number(process.env.SAMPLE_LIMIT ?? '100');
const DATA_DIR = path.join(process.cwd(), 'data', 'emoji-llm-desc');
const SAMPLE_GLOB_PREFIX = 'poc-sample-';
const EXCLUDE_OUT = process.env.EXCLUDE_OUT ?? path.join(DATA_DIR, 'poc-exclude-all.txt');

async function listSampleFiles(): Promise<string[]> {
  const entries = await fs.readdir(DATA_DIR);
  const files = entries
    .filter((entry) => entry.startsWith(SAMPLE_GLOB_PREFIX) && entry.endsWith('.txt'))
    .sort((a, b) => {
      const aNum = Number(a.slice(SAMPLE_GLOB_PREFIX.length, -4));
      const bNum = Number(b.slice(SAMPLE_GLOB_PREFIX.length, -4));
      return aNum - bNum;
    });
  return files;
}

async function buildExcludeFile(sampleFiles: string[]): Promise<{ count: number; nextSample: string }> {
  const seen = new Set<string>();
  for (const file of sampleFiles) {
    const content = await fs.readFile(path.join(DATA_DIR, file), 'utf8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      seen.add(trimmed);
    }
  }

  await fs.mkdir(path.dirname(EXCLUDE_OUT), { recursive: true });
  await fs.writeFile(EXCLUDE_OUT, `${Array.from(seen).join('\n')}\n`, 'utf8');

  const last = sampleFiles.at(-1);
  const lastIndex = last ? Number(last.slice(SAMPLE_GLOB_PREFIX.length, -4)) : 0;
  const nextSample = path.join(DATA_DIR, `poc-sample-${lastIndex + 1}.txt`);

  return { count: seen.size, nextSample };
}

async function runSample(excludeFile: string, sampleOut: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      'node',
      ['--import=tsx', path.join('scripts', 'emoji-selector-poc-llm-desc.ts')],
      {
        env: {
          ...process.env,
          SAMPLE_LIMIT: String(SAMPLE_LIMIT),
          EXCLUDE_FILE: excludeFile,
          SAMPLE_OUT: sampleOut,
        },
        stdio: 'inherit',
      },
    );
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`Sample run failed with exit code ${code ?? 'unknown'}`));
        return;
      }
      resolve();
    });
  });
}

const sampleFiles = await listSampleFiles();
const { count, nextSample } = await buildExcludeFile(sampleFiles);

console.log(`Exclude list: ${EXCLUDE_OUT} (${count} entries)`);
console.log(`Next sample file: ${nextSample}`);
console.log(`Running sample with SAMPLE_LIMIT=${SAMPLE_LIMIT}...`);

await runSample(EXCLUDE_OUT, nextSample);
