# ElevenLabs Voice Integration Research

## Executive Summary
This document explores integrating ElevenLabs voice technology with Alfred to enable voice-based communication from mobile devices as an alternative modality to Slack text threads.

## What is ElevenLabs?
ElevenLabs is a leading voice AI platform that provides:
- **Text-to-Speech (TTS)**: Convert text to natural-sounding speech with various voices
- **Speech-to-Text (STT)**: Transcribe audio to text
- **Voice Cloning**: Create custom voices
- **Conversational AI**: Real-time voice conversations

## ElevenLabs API Capabilities

### 1. Text-to-Speech (TTS)
- **Endpoint**: `POST /v1/text-to-speech/{voice_id}`
- **Input**: Text string, voice settings
- **Output**: Audio file (MP3, PCM, etc.)
- **Use case**: Convert Alfred's responses to voice
- **Features**:
  - Multiple voices (premade and custom)
  - Adjustable stability, clarity, and style
  - Streaming support for real-time playback

### 2. Speech-to-Text (STT) / Dubbing
- **Note**: ElevenLabs primarily focuses on TTS; STT capabilities are limited
- **Alternative**: Use Whisper API (OpenAI) or other STT services for voice input

### 3. Conversational AI
- **Endpoint**: WebSocket-based real-time conversation API
- **Features**:
  - Real-time bidirectional voice communication
  - Low latency responses
  - Natural conversational flow
- **Use case**: Full duplex voice conversations with Alfred

## Architecture Options

### Option 1: Phone App with Voice Interface (Recommended)
**Architecture:**
```
Phone App (iOS/Android)
  ├─> Voice Input → STT Service (Whisper/ElevenLabs)
  ├─> Alfred Backend (new HTTP/WebSocket endpoint)
  │    ├─> Codex Thread Processing (existing)
  │    └─> Response Generation
  └─> TTS (ElevenLabs) → Voice Output
```

**Pros:**
- Native mobile experience
- Full control over UX
- Can leverage device capabilities (push notifications, background processing)
- Better voice quality and lower latency

**Cons:**
- Requires building and maintaining mobile apps
- App store distribution overhead
- More complex development

**Implementation Steps:**
1. Create REST/WebSocket API endpoint in Alfred
2. Build mobile app with voice recording
3. Integrate STT for transcription
4. Process through existing Codex flow
5. Use ElevenLabs TTS for responses
6. Stream audio back to phone

### Option 2: Progressive Web App (PWA)
**Architecture:**
```
Browser (Mobile Safari/Chrome)
  ├─> Web Speech API / MediaRecorder
  ├─> Alfred Web Server
  │    ├─> STT Processing
  │    ├─> Codex Integration
  │    └─> ElevenLabs TTS
  └─> Audio Playback (Web Audio API)
```

**Pros:**
- No app store approval needed
- Cross-platform (iOS, Android, desktop)
- Easier to deploy and update
- Reuses web technologies

**Cons:**
- Limited device integration
- Browser permissions required
- May have reduced functionality on iOS
- Network dependent

### Option 3: Phone Bridge via Twilio/Telephony
**Architecture:**
```
Phone Call → Twilio
  ├─> Twilio Speech Recognition
  ├─> Alfred Webhook
  │    ├─> Codex Processing
  │    └─> Response Generation
  └─> Twilio TTS or ElevenLabs TTS
```

**Pros:**
- Works on any phone (no app required)
- Familiar phone call interface
- Easy to set up

**Cons:**
- Per-minute charges for calls
- Less control over UX
- Higher latency
- No visual feedback

### Option 4: Slack Voice Messages Enhancement
**Architecture:**
```
Slack Mobile App
  ├─> Voice Message (Audio Clip)
  ├─> Download via Alfred
  │    ├─> Transcribe (Whisper)
  │    ├─> Process via Codex
  │    └─> Generate Response
  └─> Reply with Text + Audio Attachment (ElevenLabs TTS)
```

**Pros:**
- Minimal changes to existing architecture
- Reuses Slack infrastructure
- No new app needed
- Voice messages already supported in Slack

**Cons:**
- Not real-time conversation
- Requires Slack app
- Limited voice interaction UX

## ElevenLabs Integration Components

### 1. Voice Input Processing (STT)
**Recommended Solution**: OpenAI Whisper API
- Better STT accuracy than ElevenLabs
- Robust language support
- Codex-native integration opportunity

```typescript
// Pseudo-code
async function transcribeVoice(audioBuffer: Buffer): Promise<string> {
  const response = await openai.audio.transcriptions.create({
    file: audioBuffer,
    model: "whisper-1",
    language: "en"
  });
  return response.text;
}
```

### 2. Voice Output Generation (TTS)
**Primary Solution**: ElevenLabs TTS API

```typescript
interface ElevenLabsConfig {
  apiKey: string;
  voiceId: string; // e.g., "butler-like" voice for Alfred
  model?: string;  // e.g., "eleven_multilingual_v2"
}

async function synthesizeResponse(
  text: string,
  config: ElevenLabsConfig
): Promise<Buffer> {
  const response = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${config.voiceId}`,
    {
      method: 'POST',
      headers: {
        'Accept': 'audio/mpeg',
        'Content-Type': 'application/json',
        'xi-api-key': config.apiKey
      },
      body: JSON.stringify({
        text,
        model_id: config.model || "eleven_monolingual_v1",
        voice_settings: {
          stability: 0.5,
          similarity_boost: 0.75
        }
      })
    }
  );
  return Buffer.from(await response.arrayBuffer());
}
```

### 3. Conversational Flow Adapter
```typescript
interface VoiceSession {
  sessionId: string;
  threadKey: string;
  codexThreadId?: string;
  userId: string;
  createdAt: Date;
}

class VoiceSessionManager {
  async createSession(userId: string): Promise<VoiceSession>;
  async processVoiceInput(sessionId: string, audio: Buffer): Promise<{
    transcription: string;
    response: string;
    audio: Buffer;
  }>;
  async endSession(sessionId: string): Promise<void>;
}
```

## Proposed Implementation Plan

### Phase 1: Research & Design (Current)
- [x] Research ElevenLabs capabilities
- [ ] Decide on architecture (recommend Option 4 initially, then Option 2)
- [ ] Design API contracts
- [ ] Create proof of concept

### Phase 2: Core Integration
1. **Add Voice Modality Interface**
   - Create `src/voice/` directory
   - Implement `VoiceInput` and `VoiceOutput` abstractions

2. **ElevenLabs Client**
   - Implement TTS client in `src/voice/elevenlabs.ts`
   - Add configuration for API key and voice settings
   - Handle streaming and buffering

3. **STT Integration** 
   - Integrate Whisper API for transcription
   - Handle audio format conversions

4. **Session Management**
   - Track voice sessions
   - Map to Codex threads (reuse ThreadStore pattern)
   - Handle timeouts and cleanup

### Phase 3: Slack Voice Message Support (Quick Win)
1. Detect voice message attachments in Slack
2. Download and transcribe using Whisper
3. Process through existing mention handler
4. Generate TTS response with ElevenLabs
5. Post text + audio file back to thread

### Phase 4: Web/Mobile Interface (Future)
1. Design web-based voice interface
2. Implement WebSocket endpoint for real-time communication
3. Build PWA with voice recording
4. Integrate ElevenLabs for playback

## Configuration

Add to `config.ts`:
```typescript
export interface VoiceConfig {
  enabled: boolean;
  elevenlabs: {
    apiKey: string;
    voiceId: string;
    model?: string;
  };
  stt: {
    provider: 'whisper' | 'elevenlabs';
    whisperModel?: string;
  };
}
```

Environment variables:
- `ELEVENLABS_API_KEY` - ElevenLabs API key
- `ELEVENLABS_VOICE_ID` - Default voice ID (e.g., "butler" voice)
- `ALFRED_VOICE_ENABLED` - Enable/disable voice features

## Cost Considerations

### ElevenLabs Pricing (as of 2024)
- **Free Tier**: 10,000 characters/month
- **Starter**: $5/month for 30,000 characters
- **Creator**: $22/month for 100,000 characters
- **Pro**: $99/month for 500,000 characters

### Whisper API Pricing
- $0.006 per minute of audio

### Cost Optimization
- Cache frequently used responses
- Implement character/minute limits
- Use text responses by default, voice on request
- Compress audio files

## Security & Privacy

### Considerations
1. **API Key Management**
   - Store keys in secure environment variables
   - Never log or expose keys
   - Rotate keys periodically

2. **Audio Data**
   - Temporary storage only
   - Delete recordings after processing
   - Consider encryption for audio in transit

3. **User Privacy**
   - Explicit consent for voice recording
   - Clear data retention policies
   - Option to disable voice features

4. **Rate Limiting**
   - Implement per-user rate limits
   - Protect against API abuse
   - Monitor usage patterns

## Testing Strategy

### Unit Tests
- TTS client functionality
- STT transcription accuracy
- Session management

### Integration Tests
- End-to-end voice flow
- Slack voice message handling
- Error handling and fallbacks

### Manual Testing
- Voice quality assessment
- Latency measurements
- Mobile device compatibility

## Next Steps

### Immediate Actions (This PR)
1. ✅ Document ElevenLabs research
2. Create basic ElevenLabs TTS client
3. Add voice configuration options
4. Implement Slack voice message detection and handling
5. Add tests for voice components

### Future Work
- Build web interface for voice interaction
- Implement real-time conversational AI
- Add voice customization options
- Create mobile app (iOS/Android)
- Integrate voice activity detection
- Add multi-language support

## Alternative Solutions

### Other TTS Providers
- **Google Cloud Text-to-Speech**: Excellent quality, pay-per-character
- **Amazon Polly**: AWS integration, neural voices
- **Microsoft Azure Speech**: Good for enterprise
- **OpenAI TTS**: Native Codex integration, 6 voices

### Other STT Providers
- **Google Cloud Speech-to-Text**: High accuracy
- **Assembly AI**: Real-time transcription
- **Deepgram**: Fast and cost-effective

### Why ElevenLabs?
- Most natural-sounding voices
- Butler-appropriate voice options
- Good developer experience
- Active development and improvements
- Reasonable pricing for small to medium usage

## References

- [ElevenLabs API Documentation](https://elevenlabs.io/docs)
- [ElevenLabs Voices Library](https://elevenlabs.io/voices)
- [OpenAI Whisper API](https://platform.openai.com/docs/guides/speech-to-text)
- [Slack Voice/Audio Messages](https://api.slack.com/messaging/files)
- [Web Speech API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Speech_API)

## Conclusion

**Recommended Approach**: Start with **Option 4** (Slack Voice Messages Enhancement) as a quick win to validate the concept, then evolve to **Option 2** (PWA) for a richer user experience.

This approach:
1. Leverages existing Slack infrastructure
2. Requires minimal changes to Alfred's core
3. Provides immediate value
4. Creates foundation for future enhancements
5. Keeps the implementation aligned with Alfred's "thin bridge" philosophy

The integration should maintain Alfred's architectural principles:
- Keep wiring thin
- Reuse existing Codex thread management
- Use simple file-based persistence
- Maintain Docker sandbox compatibility
