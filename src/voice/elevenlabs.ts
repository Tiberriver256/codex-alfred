import { type Logger } from '../logger.js';

export interface ElevenLabsConfig {
  apiKey: string;
  voiceId: string;
  model?: string;
}

export interface VoiceSettings {
  stability?: number;
  similarityBoost?: number;
  style?: number;
  useSpeakerBoost?: boolean;
}

export interface SynthesizeOptions {
  voiceSettings?: VoiceSettings;
  optimizeStreamingLatency?: boolean;
  outputFormat?: 'mp3_44100_128' | 'pcm_16000' | 'pcm_22050' | 'pcm_24000' | 'pcm_44100';
}

export class ElevenLabsClient {
  private readonly apiKey: string;
  private readonly baseUrl = 'https://api.elevenlabs.io/v1';
  private readonly logger: Logger;

  constructor(apiKey: string, logger: Logger) {
    this.apiKey = apiKey;
    this.logger = logger;
  }

  async synthesize(
    text: string,
    voiceId: string,
    options: SynthesizeOptions = {},
  ): Promise<Buffer> {
    const url = `${this.baseUrl}/text-to-speech/${voiceId}`;
    
    const requestBody = {
      text,
      model_id: options.optimizeStreamingLatency ? 'eleven_turbo_v2' : 'eleven_monolingual_v1',
      voice_settings: {
        stability: options.voiceSettings?.stability ?? 0.5,
        similarity_boost: options.voiceSettings?.similarityBoost ?? 0.75,
        style: options.voiceSettings?.style ?? 0,
        use_speaker_boost: options.voiceSettings?.useSpeakerBoost ?? true,
      },
    };

    this.logger.debug('ElevenLabs TTS request', {
      voiceId,
      textLength: text.length,
      model: requestBody.model_id,
    });

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Accept': 'audio/mpeg',
          'Content-Type': 'application/json',
          'xi-api-key': this.apiKey,
        },
        body: JSON.stringify(requestBody),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`ElevenLabs API error (${response.status}): ${errorText}`);
      }

      const audioData = await response.arrayBuffer();
      const buffer = Buffer.from(audioData);

      this.logger.debug('ElevenLabs TTS response', {
        audioSize: buffer.length,
        format: 'mp3',
      });

      return buffer;
    } catch (error) {
      this.logger.error('ElevenLabs synthesis failed', error);
      throw error;
    }
  }

  async getVoices(): Promise<Voice[]> {
    const url = `${this.baseUrl}/voices`;

    try {
      const response = await fetch(url, {
        headers: {
          'xi-api-key': this.apiKey,
        },
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`ElevenLabs API error (${response.status}): ${errorText}`);
      }

      const data = await response.json() as { voices: Voice[] };
      return data.voices;
    } catch (error) {
      this.logger.error('Failed to fetch ElevenLabs voices', error);
      throw error;
    }
  }

  async getUserInfo(): Promise<UserInfo> {
    const url = `${this.baseUrl}/user`;

    try {
      const response = await fetch(url, {
        headers: {
          'xi-api-key': this.apiKey,
        },
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`ElevenLabs API error (${response.status}): ${errorText}`);
      }

      return await response.json() as UserInfo;
    } catch (error) {
      this.logger.error('Failed to fetch ElevenLabs user info', error);
      throw error;
    }
  }
}

export interface Voice {
  voice_id: string;
  name: string;
  category?: string;
  description?: string;
  labels?: Record<string, string>;
  preview_url?: string;
}

export interface UserInfo {
  subscription: {
    tier: string;
    character_count: number;
    character_limit: number;
    status: string;
  };
}

export function createElevenLabsClient(config: ElevenLabsConfig, logger: Logger): ElevenLabsClient {
  return new ElevenLabsClient(config.apiKey, logger);
}
