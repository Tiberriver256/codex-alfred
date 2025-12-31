import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { promisify } from 'node:util';
import { createLogger } from '../src/logger.js';

const execFileAsync = promisify(execFile);

const DEFAULT_LIMIT = 20;
const SAMPLE_LIMIT = Number(process.env.SAMPLE_LIMIT ?? DEFAULT_LIMIT);
const DOCKER_CONTAINER = 'codex-alfred-sandbox';
const LOG_PATH = '/codex-home/alfred.log';

const LOCAL_EMBEDDING_MODEL = process.env.LOCAL_EMBEDDING_MODEL ?? 'BAAI/bge-small-en-v1.5';
const EMBEDDING_BATCH_SIZE = Number(process.env.EMBEDDING_BATCH_SIZE ?? '32');
const EXCLUDE_FILE = process.env.EXCLUDE_FILE ?? '';
const SAMPLE_OUT = process.env.SAMPLE_OUT ?? '';

type EmojiVector = {
  emoji: string;
  description: string;
  shortDescription: string;
  vector: Float32Array;
  norm: number;
  model?: string;
  anchor?: boolean;
};

type EmbeddingRecord = {
  emoji: string;
  description: string;
  shortDescription: string;
  embedding: number[] | Float32Array;
  model?: string;
  anchor?: boolean;
};

type StatusSample = {
  message: string;
  legacyEmoji: string | null;
};

function stripLeadingEmoji(text: string): string {
  return text.replace(/^\p{Extended_Pictographic}(?:\uFE0F|\uFE0E)?\s*/u, '').trim();
}

function extractLeadingEmoji(text: string): string | null {
  const match = text.match(/^(\p{Extended_Pictographic}|\p{Emoji_Presentation})/u);
  return match ? match[0] : null;
}

async function loadStatusMessages(limit = DEFAULT_LIMIT): Promise<StatusSample[]> {
  const command = `rg -n "Status emoji selected" ${LOG_PATH}`;
  const { stdout } = await execFileAsync('docker', ['exec', DOCKER_CONTAINER, 'sh', '-lc', command], {
    maxBuffer: 1024 * 1024 * 20,
  });

  const messages: StatusSample[] = [];
  const seen = new Set<string>();
  const exclude = new Set<string>();

  if (EXCLUDE_FILE) {
    try {
      const raw = await fs.readFile(EXCLUDE_FILE, 'utf8');
      for (const line of raw.split('\n')) {
        const trimmed = line.trim();
        if (trimmed) exclude.add(trimmed);
      }
    } catch {
      // Ignore missing exclude file.
    }
  }

  for (const line of stdout.split('\n')) {
    if (!line.includes('Status emoji selected')) continue;
    const textMatch = line.match(/text:\s*'([^']+)'/);
    if (!textMatch) continue;
    const rawText = textMatch[1] ?? '';
    const cleaned = stripLeadingEmoji(rawText);
    if (!cleaned) continue;
    if (exclude.has(cleaned)) continue;
    if (seen.has(cleaned)) continue;
    seen.add(cleaned);
    const emojiMatch = line.match(/emoji:\s*'([^']+)'/);
    const legacyEmoji = emojiMatch?.[1]?.trim() || extractLeadingEmoji(rawText);
    messages.push({ message: cleaned, legacyEmoji: legacyEmoji || null });
  }

  if (messages.length <= limit) {
    return messages;
  }
  return messages.slice(-limit);
}

function summarize(values: number[]) {
  if (values.length === 0) {
    return { min: 0, max: 0, mean: 0, median: 0 };
  }
  const sorted = [...values].sort((a, b) => a - b);
  const min = sorted[0];
  const max = sorted[sorted.length - 1];
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
  return { min, max, mean, median };
}

function formatMs(value: number): string {
  return `${value.toFixed(0)}ms`;
}

function dataDir(): string {
  return path.join(process.cwd(), 'data');
}

function indexPath(): string {
  const safeModel = LOCAL_EMBEDDING_MODEL.replace(/[^a-z0-9_-]+/gi, '_');
  return path.join(dataDir(), 'emoji-llm-desc', `local-embeddings-${safeModel}.jsonl`);
}

async function loadEmbeddingIndex(): Promise<EmojiVector[]> {
  const filePath = indexPath();
  const raw = await fs.readFile(filePath, 'utf8');
  const rows = raw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as EmbeddingRecord);

  return rows.map((row) => {
    const vector = row.embedding instanceof Float32Array ? row.embedding : Float32Array.from(row.embedding);
    let norm = 0;
    for (let i = 0; i < vector.length; i += 1) {
      norm += vector[i] * vector[i];
    }
    norm = Math.sqrt(norm);
    return {
      emoji: row.emoji,
      description: row.description,
      shortDescription: row.shortDescription,
      vector,
      norm,
      model: row.model,
      anchor: row.anchor === true,
    };
  });
}

function cosineSimilarity(query: Float32Array, queryNorm: number, target: EmojiVector): number {
  let dot = 0;
  for (let i = 0; i < query.length && i < target.vector.length; i += 1) {
    dot += query[i] * target.vector[i];
  }
  const denom = queryNorm * target.norm;
  if (!denom) return 0;
  return dot / denom;
}

function semanticSearchWithVector(
  vector: Float32Array,
  vectors: EmojiVector[],
): { emoji: string | null; score: number; shortDescription: string } {
  let norm = 0;
  for (let i = 0; i < vector.length; i += 1) {
    norm += vector[i] * vector[i];
  }
  norm = Math.sqrt(norm);

  let best: EmojiVector | null = null;
  let bestScore = -Infinity;
  const epsilon = 1e-6;

  for (const entry of vectors) {
    const score = cosineSimilarity(vector, norm, entry);
    if (score > bestScore + epsilon) {
      bestScore = score;
      best = entry;
    } else if (Math.abs(score - bestScore) <= epsilon && entry.anchor) {
      best = entry;
    }
  }

  return {
    emoji: best?.emoji ?? null,
    score: Number(bestScore.toFixed(4)),
    shortDescription: best?.shortDescription ?? '',
  };
}

async function embedQueries(queries: string[]): Promise<number[][]> {
  return new Promise((resolve, reject) => {
    const args = ['run', path.join('scripts', 'emoji-llm-desc-embed-queries.py')];

    const child = execFile(
      'uv',
      args,
      {
        env: {
          ...process.env,
          LOCAL_EMBEDDING_MODEL,
          EMBEDDING_BATCH_SIZE: String(EMBEDDING_BATCH_SIZE),
        },
        maxBuffer: 1024 * 1024 * 100,
        timeout: 0,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(stderr || error.message));
          return;
        }
        try {
          const data = JSON.parse(stdout) as number[][];
          resolve(data);
        } catch (parseError) {
          reject(parseError);
        }
      },
    );

    child.stdin?.write(JSON.stringify(queries));
    child.stdin?.end();
  });
}

const logger = createLogger('info');

const statusSamples = await loadStatusMessages(SAMPLE_LIMIT);
if (statusSamples.length < SAMPLE_LIMIT) {
  console.error(`Only found ${statusSamples.length} status messages; need ${SAMPLE_LIMIT}.`);
  process.exit(1);
}
if (SAMPLE_OUT) {
  try {
    await fs.writeFile(
      SAMPLE_OUT,
      statusSamples.map((sample) => sample.message).join('\n'),
      'utf8',
    );
  } catch {
    // Ignore sample write failures.
  }
}

let vectors: EmojiVector[] = [];
const semanticInitStart = performance.now();
try {
  vectors = await loadEmbeddingIndex();
} catch (error) {
  console.error('Semantic embeddings are missing. Run these first:');
  console.error('  node --import=tsx scripts/emoji-llm-desc-download.ts');
  console.error('  uv run scripts/emoji-llm-desc-embed.py');
  console.error(String(error));
  process.exit(1);
}
const semanticInitMs = performance.now() - semanticInitStart;

const modelFromFile = vectors.find((row) => row.model)?.model;
if (modelFromFile && modelFromFile !== LOCAL_EMBEDDING_MODEL) {
  console.warn(`Embedding file model is ${modelFromFile}, but LOCAL_EMBEDDING_MODEL is ${LOCAL_EMBEDDING_MODEL}.`);
}

let queryEmbeddings: number[][] = [];
let queryEmbeddingMs = 0;
try {
  const startedAt = performance.now();
  queryEmbeddings = await embedQueries(statusSamples.map((sample) => sample.message));
  queryEmbeddingMs = performance.now() - startedAt;
} catch (error) {
  console.error('Failed to embed queries via uv run. Ensure uv is installed and retry:');
  console.error('  uv run scripts/emoji-llm-desc-embed-queries.py');
  console.error(String(error));
  process.exit(1);
}

const rows: Array<{
  message: string;
  legacyEmoji: string | null;
  semanticEmoji: string | null;
  semanticMs: number;
  semanticScore: number;
  semanticDescription: string;
}> = [];

for (const sample of statusSamples) {
  const semanticStart = performance.now();
  const embedding = queryEmbeddings.shift();
  const vector = embedding ? Float32Array.from(embedding) : new Float32Array();
  const semantic = semanticSearchWithVector(vector, vectors);
  const similarityMs = performance.now() - semanticStart;
  const semanticMs = similarityMs + queryEmbeddingMs / statusSamples.length;

  rows.push({
    message: sample.message,
    legacyEmoji: sample.legacyEmoji,
    semanticEmoji: semantic.emoji,
    semanticMs,
    semanticScore: semantic.score,
    semanticDescription: semantic.shortDescription,
  });
}

const semanticTimes = rows.map((row) => row.semanticMs);
const semanticSummary = summarize(semanticTimes);

console.log('Emoji selector POC (LLM descriptions, FastEmbed)');
console.log('===============================================');
console.log(`Status messages: ${rows.length}`);
console.log(`Local model: ${LOCAL_EMBEDDING_MODEL}`);
console.log('Legacy init: removed');
console.log(`Semantic init: ${formatMs(semanticInitMs)}`);
console.log(`Query embedding batch: ${formatMs(queryEmbeddingMs)} (averaged across messages)`);
console.log('');
console.log('Per-message timings:');
console.log(`Semantic mean ${formatMs(semanticSummary.mean)} (min ${formatMs(semanticSummary.min)}, max ${formatMs(semanticSummary.max)}, median ${formatMs(semanticSummary.median)})`);
console.log('');
console.log('Results:');
for (const row of rows) {
  const legacyEmoji = row.legacyEmoji ?? '∅';
  const semanticEmoji = row.semanticEmoji ?? '∅';
  console.log(`- ${row.message}`);
  console.log(`  legacy: ${legacyEmoji} (log)`);
  console.log(
    `  semantic: ${semanticEmoji} (${formatMs(row.semanticMs)}; score ${row.semanticScore}; ${row.semanticDescription})`,
  );
}
