import { createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline as streamPipeline } from 'node:stream/promises';

const DATASET_URL =
  'https://huggingface.co/datasets/badrex/LLM-generated-emoji-descriptions/resolve/main/data/train-00000-of-00001.parquet';

function dataDir(): string {
  return path.join(process.cwd(), 'data');
}

function datasetPath(): string {
  return path.join(dataDir(), 'emoji-llm-desc', 'llm-emoji-descriptions.parquet');
}

const targetPath = datasetPath();
const force = process.env.FORCE === '1';

try {
  await fs.access(targetPath);
  if (!force) {
    console.log(`Dataset already exists at ${targetPath}. Set FORCE=1 to re-download.`);
    process.exit(0);
  }
} catch {
  // Continue to download.
}

const response = await fetch(DATASET_URL);
if (!response.ok || !response.body) {
  console.error(`Dataset download failed (${response.status}).`);
  process.exit(1);
}

await fs.mkdir(path.dirname(targetPath), { recursive: true });
const tmpPath = `${targetPath}.tmp`;

await streamPipeline(Readable.fromWeb(response.body), createWriteStream(tmpPath));
await fs.rename(tmpPath, targetPath);

console.log(`Downloaded dataset to ${targetPath}.`);
