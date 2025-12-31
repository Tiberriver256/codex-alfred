import fs from 'node:fs/promises';
import path from 'node:path';

const ROOT = process.cwd();
const SOURCE = path.join(ROOT, 'data', 'emoji-llm-desc', 'local-embeddings-BAAI_bge-small-en-v1_5.jsonl');
const DEST = path.join(ROOT, 'dist', 'emoji-llm-desc', 'local-embeddings-BAAI_bge-small-en-v1_5.jsonl');

try {
  await fs.access(SOURCE);
} catch {
  console.error(`Embeddings file missing: ${SOURCE}`);
  process.exit(1);
}

await fs.mkdir(path.dirname(DEST), { recursive: true });
await fs.copyFile(SOURCE, DEST);

console.log(`Copied embeddings to ${DEST}`);
