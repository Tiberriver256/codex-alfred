import { type Logger } from '../logger.js';
import { type SlackClientLike, type SlackMessage } from '../slack/types.js';
import { createElevenLabsClient, type ElevenLabsConfig } from './elevenlabs.js';
import { isAudioFile, downloadAudioFile, cleanupAudioFile } from './audioHandler.js';
import fs from 'node:fs/promises';
import path from 'node:path';

export interface VoiceResponseOptions {
  elevenlabs: ElevenLabsConfig;
  botToken: string;
  workDir: string;
  logger: Logger;
}

const ELEVENLABS_MAX_CHARS = 5000;
const ELEVENLABS_TRUNCATE_AT = 4900;

export async function generateVoiceResponse(
  responseText: string,
  options: VoiceResponseOptions,
): Promise<{ audioPath: string; text: string } | null> {
  const { elevenlabs, workDir, logger } = options;

  try {
    const client = createElevenLabsClient(elevenlabs, logger);
    
    const textForSpeech = stripMarkdown(responseText);
    
    if (textForSpeech.length === 0) {
      logger.warn('No text to convert to speech');
      return null;
    }

    if (textForSpeech.length > ELEVENLABS_MAX_CHARS) {
      logger.warn('Text too long for TTS, truncating', { length: textForSpeech.length });
      const truncated = textForSpeech.slice(0, ELEVENLABS_TRUNCATE_AT) + '... (message truncated)';
      const audioBuffer = await client.synthesize(truncated, elevenlabs.voiceId);
      const audioPath = await saveAudioToWorkspace(audioBuffer, workDir, logger);
      return { audioPath, text: truncated };
    }

    const audioBuffer = await client.synthesize(textForSpeech, elevenlabs.voiceId);
    const audioPath = await saveAudioToWorkspace(audioBuffer, workDir, logger);

    return { audioPath, text: textForSpeech };
  } catch (error) {
    logger.error('Failed to generate voice response', error);
    return null;
  }
}

async function saveAudioToWorkspace(
  audioBuffer: Buffer,
  workDir: string,
  logger: Logger,
): Promise<string> {
  const timestamp = Date.now();
  const filename = `alfred-response-${timestamp}.mp3`;
  const audioPath = path.join(workDir, filename);

  await fs.writeFile(audioPath, audioBuffer);

  logger.debug('Voice response saved', {
    path: audioPath,
    size: audioBuffer.length,
  });

  return audioPath;
}

export function stripMarkdown(text: string): string {
  let cleaned = text;

  cleaned = cleaned.replace(/```[^`]*```/g, '[code block]');
  cleaned = cleaned.replace(/\*\*\*(.+?)\*\*\*/g, '$1');
  cleaned = cleaned.replace(/\*\*(.+?)\*\*/g, '$1');
  cleaned = cleaned.replace(/\*(.+?)\*/g, '$1');
  cleaned = cleaned.replace(/__(.+?)__/g, '$1');
  cleaned = cleaned.replace(/_(.+?)_/g, '$1');
  cleaned = cleaned.replace(/~~(.+?)~~/g, '$1');
  cleaned = cleaned.replace(/`(.+?)`/g, '$1');
  cleaned = cleaned.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
  cleaned = cleaned.replace(/^#+\s+/gm, '');
  cleaned = cleaned.replace(/^>\s+/gm, '');
  cleaned = cleaned.replace(/^[-*+]\s+/gm, '');
  cleaned = cleaned.replace(/^\d+\.\s+/gm, '');
  cleaned = cleaned.replace(/\n{3,}/g, '\n\n');

  return cleaned.trim();
}

export async function hasAudioAttachment(messages: SlackMessage[]): Promise<boolean> {
  for (const msg of messages) {
    if (msg.files && msg.files.length > 0) {
      for (const file of msg.files) {
        if (await isAudioFile(file)) {
          return true;
        }
      }
    }
  }
  return false;
}

export async function shouldGenerateVoiceResponse(
  messages: SlackMessage[],
  userRequestedVoice: boolean,
): Promise<boolean> {
  if (userRequestedVoice) return true;
  
  return await hasAudioAttachment(messages);
}

export function extractVoiceRequestFromText(text: string): {
  requestsVoice: boolean;
  cleanedText: string;
} {
  const voiceKeywords = [
    'with voice',
    'as voice',
    'voice response',
    'voice reply',
    'say it',
    'speak',
    'audio response',
    'audio reply',
  ];

  const lowerText = text.toLowerCase();
  const requestsVoice = voiceKeywords.some(keyword => lowerText.includes(keyword));

  let cleanedText = text;
  for (const keyword of voiceKeywords) {
    const escapedKeyword = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`\\b${escapedKeyword}\\b`, 'gi');
    cleanedText = cleanedText.replace(regex, '').trim();
  }

  return { requestsVoice, cleanedText };
}
