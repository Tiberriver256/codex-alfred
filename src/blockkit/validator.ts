import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface BlockKitMessage {
  text: string;
  blocks: unknown[];
  attachments?: Array<{
    path: string;
    filename?: string;
    title?: string;
  }>;
}

export async function loadBlockKitOutputSchema(schemaPath?: string): Promise<object> {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const resolvedPath = schemaPath ?? path.resolve(repoRoot, 'schemas', 'blockkit-response.openai.schema.json');
  const raw = await fs.readFile(resolvedPath, 'utf8');
  return JSON.parse(raw) as object;
}
