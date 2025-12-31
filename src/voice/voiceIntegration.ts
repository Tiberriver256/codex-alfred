import { type Logger } from '../logger.js';
import { type SlackClientLike, type SlackMessage } from '../slack/types.js';
import { type VoiceConfig } from '../config.js';
import { generateVoiceResponse, shouldGenerateVoiceResponse, extractVoiceRequestFromText } from './voiceResponse.js';
import fs from 'node:fs/promises';

export interface VoiceIntegrationParams {
  responseText: string;
  messages: SlackMessage[];
  voiceConfig: VoiceConfig;
  botToken: string;
  workDir: string;
  logger: Logger;
  client: SlackClientLike;
  channel: string;
  threadTs: string;
  threadKey: string;
}

export async function maybeGenerateAndPostVoiceResponse(
  params: VoiceIntegrationParams,
): Promise<void> {
  const { responseText, messages, voiceConfig, botToken, workDir, logger, client, channel, threadTs, threadKey } = params;

  if (!voiceConfig.enabled || !voiceConfig.elevenlabs) {
    return;
  }

  const userRequestedVoice = messages.some(msg => {
    const { requestsVoice } = extractVoiceRequestFromText(msg.text ?? '');
    return requestsVoice;
  });

  if (!await shouldGenerateVoiceResponse(messages, userRequestedVoice)) {
    return;
  }

  logger.info('Generating voice response', { threadKey });

  try {
    const voiceResult = await generateVoiceResponse(responseText, {
      elevenlabs: voiceConfig.elevenlabs,
      botToken,
      workDir,
      logger,
    });

    if (!voiceResult) {
      logger.warn('Voice response generation failed', { threadKey });
      return;
    }

    if (!client.files?.uploadV2) {
      logger.warn('Slack files API not available', { threadKey });
      return;
    }

    const audioData = await fs.readFile(voiceResult.audioPath);

    const uploadResult = await client.files.uploadV2({
      channel_id: channel,
      thread_ts: threadTs,
      file: audioData,
      filename: `alfred-voice-${Date.now()}.mp3`,
      title: 'Alfred Voice Response',
      initial_comment: '🎙️ Voice response',
    });

    const fileId = uploadResult.files?.[0]?.id;

    logger.info('Voice response posted', {
      threadKey,
      fileId,
      audioPath: voiceResult.audioPath,
    });
  } catch (error) {
    logger.error('Failed to generate or post voice response', { threadKey, error });
  }
}
