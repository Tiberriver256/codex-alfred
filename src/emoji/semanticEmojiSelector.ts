import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Logger } from '../logger.js';

export type EmojiSearchResult = {
  emoji: string;
  message: string;
  score: number;
};

type EmojiEmbedding = {
  emoji: string;
  message: string;
  shortDescription: string;
  anchor?: boolean;
  vector: Float32Array;
  norm: number;
};

let embeddingsCache: EmojiEmbedding[] | null = null;
let embeddingsPromise: Promise<EmojiEmbedding[] | null> | null = null;
let embeddingsCachePath: string | null = null;
const DEFAULT_EMBEDDING_MODEL = 'BAAI/bge-small-en-v1.5';

function resolveProjectRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const base = path.resolve(here, '..', '..');
  const baseName = path.basename(base);
  if (baseName === 'dist' || baseName === 'src') {
    return path.resolve(base, '..');
  }
  return base;
}

function resolveEmbeddingsPath(): { primary: string; fallback: string } {
  const root = resolveProjectRoot();
  const distPath = path.join(root, 'dist', 'emoji-llm-desc', 'local-embeddings-BAAI_bge-small-en-v1_5.jsonl');
  const dataPath = path.join(root, 'data', 'emoji-llm-desc', 'local-embeddings-BAAI_bge-small-en-v1_5.jsonl');
  return { primary: distPath, fallback: dataPath };
}

async function loadEmbeddings(dataDir: string, logger: Logger): Promise<EmojiEmbedding[] | null> {
  const { primary, fallback } = resolveEmbeddingsPath();
  let datasetPath = primary;
  try {
    await fs.access(primary);
  } catch {
    if (fallback !== primary) {
      try {
        await fs.access(fallback);
        datasetPath = fallback;
      } catch {
        logger.warn('Semantic emoji selector unavailable: embeddings file missing', { datasetPath: primary });
        return null;
      }
    } else {
      logger.warn('Semantic emoji selector unavailable: embeddings file missing', { datasetPath: primary });
      return null;
    }
  }

  if (embeddingsCache && embeddingsCachePath === datasetPath) {
    return embeddingsCache;
  }

  if (!embeddingsPromise || embeddingsCachePath !== datasetPath) {
    embeddingsCachePath = datasetPath;
    embeddingsPromise = (async () => {
      try {
        const raw = await fs.readFile(datasetPath, 'utf8');
        const lines = raw.split('\n');
        const results: EmojiEmbedding[] = [];

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          const record = JSON.parse(trimmed) as {
            emoji?: string;
            shortDescription?: string;
            description?: string;
            embedding?: number[];
            anchor?: boolean;
          };
          if (!record.emoji || !record.embedding || record.embedding.length === 0) continue;

          const vector = Float32Array.from(record.embedding);
          let norm = 0;
          for (let j = 0; j < vector.length; j += 1) {
            norm += vector[j] * vector[j];
          }
          norm = Math.sqrt(norm);
          if (!norm) continue;

          results.push({
            emoji: String(record.emoji),
            shortDescription: record.shortDescription ? String(record.shortDescription) : '',
            message: record.description ? String(record.description) : '',
            anchor: record.anchor === true,
            vector,
            norm,
          });
        }

        embeddingsCache = results;
        return results;
      } catch (error) {
        logger.warn('Failed to load emoji embeddings', { error });
        return null;
      }
    })();
  }

  return embeddingsPromise;
}

function resolveEmbedQueryScript(): string {
  if (process.env.EMOJI_EMBED_QUERIES_SCRIPT) {
    return process.env.EMOJI_EMBED_QUERIES_SCRIPT;
  }
  return path.join(resolveProjectRoot(), 'scripts', 'emoji-llm-desc-embed-queries.py');
}

async function embedQuery(query: string, logger: Logger): Promise<Float32Array | null> {
  const scriptPath = resolveEmbedQueryScript();
  try {
    await fs.access(scriptPath);
  } catch {
    logger.warn('Emoji embedder script missing', { scriptPath });
    return null;
  }

  try {
    const parsed = await new Promise<number[][]>((resolve, reject) => {
      const child = spawn('uv', ['run', scriptPath], {
        env: {
          ...process.env,
          LOCAL_EMBEDDING_MODEL: process.env.EMOJI_EMBEDDINGS_MODEL ?? DEFAULT_EMBEDDING_MODEL,
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => {
        stdout += chunk.toString();
      });
      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString();
      });
      child.on('error', (error) => reject(error));
      child.on('close', (code) => {
        if (code !== 0) {
          reject(new Error(stderr || `emoji embedder exited with code ${code ?? 'unknown'}`));
          return;
        }
        try {
          resolve(JSON.parse(stdout) as number[][]);
        } catch (parseError) {
          reject(parseError);
        }
      });

      child.stdin.write(JSON.stringify([query]));
      child.stdin.end();
    });

    const first = parsed[0];
    if (!first || first.length === 0) return null;
    return Float32Array.from(first);
  } catch (error) {
    logger.warn('Failed to embed emoji query', { error });
    return null;
  }
}

function cosineSimilarity(query: Float32Array, queryNorm: number, target: EmojiEmbedding): number {
  let dot = 0;
  for (let i = 0; i < query.length && i < target.vector.length; i += 1) {
    dot += query[i] * target.vector[i];
  }
  const denom = queryNorm * target.norm;
  if (!denom) return 0;
  return dot / denom;
}

export async function searchEmoji(query: string, params: { dataDir: string; logger: Logger; topK?: number }): Promise<EmojiSearchResult[]> {
  const { dataDir, logger, topK = 5 } = params;
  const embeddings = await loadEmbeddings(dataDir, logger);
  if (!embeddings || embeddings.length === 0) return [];

  const vector = await embedQuery(query, logger);
  if (!vector) return [];

  let queryNorm = 0;
  for (let i = 0; i < vector.length; i += 1) {
    queryNorm += vector[i] * vector[i];
  }
  queryNorm = Math.sqrt(queryNorm);

  const hits: Array<{ score: number; item: EmojiEmbedding }> = [];
  const epsilon = 1e-6;

  for (const item of embeddings) {
    const score = cosineSimilarity(vector, queryNorm, item);
    if (hits.length < topK) {
      hits.push({ score, item });
      hits.sort((a, b) => b.score - a.score);
      continue;
    }
    if (score > hits[hits.length - 1].score) {
      hits[hits.length - 1] = { score, item };
      hits.sort((a, b) => b.score - a.score);
      continue;
    }
    if (Math.abs(score - hits[hits.length - 1].score) <= epsilon && item.anchor) {
      hits[hits.length - 1] = { score, item };
      hits.sort((a, b) => b.score - a.score);
    }
  }

  return hits.map((hit) => ({
    emoji: hit.item.emoji,
    message: hit.item.message,
    score: Number(hit.score.toFixed(4)),
  }));
}

export async function createSemanticEmojiSelector(params: {
  dataDir: string;
  logger: Logger;
}): Promise<{ selectEmoji: (text: string) => Promise<string | null> } | null> {
  const { dataDir, logger } = params;
  const embeddings = await loadEmbeddings(dataDir, logger);
  if (!embeddings || embeddings.length === 0) {
    logger.warn('Semantic emoji selector unavailable: embeddings not loaded');
    return null;
  }

  return {
    selectEmoji: async (text: string) => {
      const startedAt = Date.now();
      try {
        const results = await searchEmoji(text, { dataDir, logger, topK: 1 });
        const emoji = results[0]?.emoji ?? null;
        if (logger.debug) {
          logger.debug('Status emoji selected (semantic)', {
            latencyMs: Date.now() - startedAt,
            emoji,
            query: text,
          });
        }
        return emoji;
      } catch (error) {
        logger.warn('Semantic emoji selection failed', { error });
        return null;
      }
    },
  };
}
