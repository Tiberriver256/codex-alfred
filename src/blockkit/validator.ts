import fs from 'node:fs/promises';
import path from 'node:path';
import Ajv from 'ajv';

export interface BlockKitMessage {
  text: string;
  blocks: unknown[];
}

export interface BlockKitValidationResult {
  ok: boolean;
  errors?: string[];
}

export async function loadBlockKitSchema(schemaPath?: string): Promise<object> {
  const resolvedPath = schemaPath ?? path.resolve(process.cwd(), 'schemas', 'blockkit-response.schema.json');
  const raw = await fs.readFile(resolvedPath, 'utf8');
  return JSON.parse(raw) as object;
}

export function createBlockKitValidator(schema: object) {
  const ajv = new Ajv({ allErrors: true, strict: false });
  const validate = ajv.compile(schema);

  const validateBlockKit = (payload: unknown): BlockKitValidationResult => {
    const ok = Boolean(validate(payload));
    if (ok) return { ok: true };
    const errors = (validate.errors ?? []).map((err) => `${err.instancePath || 'root'} ${err.message ?? 'invalid'}`);
    return { ok: false, errors };
  };

  return { validateBlockKit };
}

export function buildFallbackMessage(summary: string): BlockKitMessage {
  return {
    text: `Alfred error: ${summary}`,
    blocks: [
      {
        type: 'header',
        text: {
          type: 'plain_text',
          text: 'Alfred error',
        },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `Sorry — I couldn't generate a valid response.\n_${summary}_`,
        },
      },
    ],
  };
}
