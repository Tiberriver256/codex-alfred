import { type Logger } from '../logger.js';
import { type SlackFile } from '../slack/types.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

export interface AudioTranscription {
  text: string;
  language?: string;
  duration?: number;
}

export async function isAudioFile(file: SlackFile): Promise<boolean> {
  if (!file.mimetype) return false;
  
  const audioMimeTypes = [
    'audio/mpeg',
    'audio/mp3',
    'audio/wav',
    'audio/wave',
    'audio/x-wav',
    'audio/ogg',
    'audio/webm',
    'audio/mp4',
    'audio/m4a',
    'audio/x-m4a',
  ];
  
  return audioMimeTypes.includes(file.mimetype.toLowerCase());
}

export async function downloadAudioFile(
  file: SlackFile,
  botToken: string,
  logger: Logger,
): Promise<string | null> {
  if (!file.url_private_download && !file.url_private) {
    logger.warn('Audio file missing download URL', { fileId: file.id });
    return null;
  }

  const url = file.url_private_download ?? file.url_private;
  if (!url) return null;

  try {
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${botToken}`,
      },
    });

    if (!response.ok) {
      logger.error('Failed to download audio file', {
        fileId: file.id,
        status: response.status,
      });
      return null;
    }

    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'alfred-audio-'));
    const ext = path.extname(file.name ?? 'audio.mp3') || '.mp3';
    const filePath = path.join(tmpDir, `audio${ext}`);
    
    await fs.writeFile(filePath, buffer);

    logger.debug('Audio file downloaded', {
      fileId: file.id,
      size: buffer.length,
      path: filePath,
    });

    return filePath;
  } catch (error) {
    logger.error('Audio download failed', { fileId: file.id, error });
    return null;
  }
}

export async function cleanupAudioFile(filePath: string, logger: Logger): Promise<void> {
  try {
    const dir = path.dirname(filePath);
    await fs.rm(dir, { recursive: true, force: true });
    logger.debug('Audio file cleaned up', { path: filePath });
  } catch (error) {
    logger.warn('Audio cleanup failed', { path: filePath, error });
  }
}

export function extractTextFromAudio(text: string): string {
  return text.trim();
}
