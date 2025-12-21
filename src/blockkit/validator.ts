import fs from 'node:fs/promises';
import path from 'node:path';

export interface BlockKitMessage {
  text: string;
  blocks: unknown[];
}

export async function loadBlockKitOutputSchema(schemaPath?: string): Promise<object> {
  const resolvedPath =
    schemaPath ?? path.resolve(process.cwd(), 'schemas', 'blockkit-response.openai.schema.json');
  const raw = await fs.readFile(resolvedPath, 'utf8');
  return JSON.parse(raw) as object;
}
