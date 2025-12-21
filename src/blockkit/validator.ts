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

export async function loadBlockKitOutputSchema(schemaPath?: string): Promise<object> {
  const resolvedPath =
    schemaPath ?? path.resolve(process.cwd(), 'schemas', 'blockkit-response.openai.schema.json');
  const raw = await fs.readFile(resolvedPath, 'utf8');
  return JSON.parse(raw) as object;
}

export async function loadBlockKitSchema(schemaPath?: string): Promise<object> {
  const resolvedPath = schemaPath ?? path.resolve(process.cwd(), 'schemas', 'blockkit-response.schema.json');
  const raw = await fs.readFile(resolvedPath, 'utf8');
  return JSON.parse(raw) as object;
}

type AjvValidate = ((payload: unknown) => boolean) & {
  errors?: { instancePath?: string; message?: string }[] | null;
};

export function createBlockKitValidator(schema: object) {
  const AjvCtor = Ajv as unknown as new (options: { allErrors: boolean; strict: boolean }) => {
    compile: (schema: object) => AjvValidate;
  };
  const ajv = new AjvCtor({ allErrors: true, strict: false });
  const validate = ajv.compile(schema);

  const validateBlockKit = (payload: unknown): BlockKitValidationResult => {
    const ok = Boolean(validate(payload));
    if (ok) return { ok: true };
    const errors = (validate.errors ?? []).map((err: { instancePath?: string; message?: string }) => {
      return `${err.instancePath || 'root'} ${err.message ?? 'invalid'}`;
    });
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
