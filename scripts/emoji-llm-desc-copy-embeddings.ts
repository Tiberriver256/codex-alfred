import fs from 'node:fs/promises';
import path from 'node:path';

const ROOT = process.cwd();
const EMBEDDINGS_SOURCE = path.join(
  ROOT,
  'data',
  'emoji-llm-desc',
  'local-embeddings-BAAI_bge-small-en-v1_5.jsonl',
);
const EMBEDDINGS_DEST = path.join(
  ROOT,
  'dist',
  'emoji-llm-desc',
  'local-embeddings-BAAI_bge-small-en-v1_5.jsonl',
);
const QUERIES_SOURCE = path.join(ROOT, 'scripts', 'emoji-llm-desc-embed-queries.py');
const QUERIES_DEST = path.join(ROOT, 'dist', 'scripts', 'emoji-llm-desc-embed-queries.py');

try {
  await fs.access(EMBEDDINGS_SOURCE);
} catch {
  console.error(`Embeddings file missing: ${EMBEDDINGS_SOURCE}`);
  process.exit(1);
}

await fs.mkdir(path.dirname(EMBEDDINGS_DEST), { recursive: true });
await fs.copyFile(EMBEDDINGS_SOURCE, EMBEDDINGS_DEST);

try {
  await fs.access(QUERIES_SOURCE);
  await fs.mkdir(path.dirname(QUERIES_DEST), { recursive: true });
  await fs.copyFile(QUERIES_SOURCE, QUERIES_DEST);
  console.log(`Copied embedder script to ${QUERIES_DEST}`);
} catch {
  console.warn(`Embedder script missing: ${QUERIES_SOURCE}`);
}

console.log(`Copied embeddings to ${EMBEDDINGS_DEST}`);
