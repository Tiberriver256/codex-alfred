# Voice Integration Example

This document provides examples of how to integrate voice features into Alfred's Slack message flow.

## Basic Integration Pattern

The voice integration follows this pattern:

1. Process user message through Codex (existing flow)
2. Post text response to Slack (existing flow)
3. Optionally generate voice response (new)
4. Upload voice response as audio file (new)

## Code Example: Integration in mentionHandler.ts

```typescript
import { maybeGenerateAndPostVoiceResponse } from '../voice/voiceIntegration.js';

// ... inside handleAppMention function, after runCodexAndPost:

({ response, output } = await runCodexAndPost({
  thread: activeThread,
  prompt,
  outputSchema: blockKitOutputSchema,
  logger,
  threadKey,
  client,
  channel: event.channel,
  threadTs,
  workDir: config.workDir,
  dataDir: config.dataDir,
  sandbox: config.sandbox,
  abortSignal: abortController.signal,
}));

// NEW: Generate and post voice response if enabled
if (config.voice.enabled && response && output) {
  await maybeGenerateAndPostVoiceResponse({
    responseText: output.text,
    messages,
    voiceConfig: config.voice,
    botToken: config.botToken,
    workDir: config.workDir,
    logger,
    client,
    channel: event.channel,
    threadTs,
    threadKey,
  });
}
```

## Integration Points

### 1. App Configuration

The voice config is already integrated into `AppConfig`:

```typescript
export interface AppConfig {
  // ... existing fields
  voice: VoiceConfig;
}

export interface VoiceConfig {
  enabled: boolean;
  elevenlabs?: {
    apiKey: string;
    voiceId: string;
    model?: string;
  };
}
```

### 2. Voice Response Generation

The `maybeGenerateAndPostVoiceResponse` function handles:

- Checking if voice is enabled
- Detecting if user requested voice response
- Checking if user sent a voice message
- Generating TTS audio with ElevenLabs
- Uploading audio file to Slack thread

### 3. Message Processing

Voice keywords are detected automatically:

```typescript
const { requestsVoice, cleanedText } = extractVoiceRequestFromText(message.text);
// requestsVoice: true if message contains "with voice", "say it", etc.
// cleanedText: message with voice keywords removed
```

## Complete Integration Example

Here's a complete example showing all integration points:

```typescript
// src/slack/mentionHandler.ts

import { maybeGenerateAndPostVoiceResponse } from '../voice/voiceIntegration.js';
import { extractVoiceRequestFromText } from '../voice/voiceResponse.js';

export async function handleAppMention(
  params: { event: MentionEvent; ack: () => Promise<void> },
  deps: MentionDeps,
): Promise<void> {
  const { event, ack } = params;
  const { client, store, codex, work, config, logger, botUserId, blockKitOutputSchema } = deps;

  await ack();

  // ... existing setup code ...

  let thread: Awaited<ReturnType<CodexClient['startThread']>> | undefined;
  let messages: SlackMessage[] = [];
  let response: { ts?: string } | undefined;
  let output: BlockKitMessage | undefined;
  
  try {
    // ... existing thread setup and message fetching ...

    // NEW: Clean voice keywords from messages before building prompt
    const cleanedMessages = messages.map(msg => {
      const { cleanedText } = extractVoiceRequestFromText(msg.text ?? '');
      return { ...msg, text: cleanedText };
    });

    const prompt = buildPrompt(
      event.channel,
      threadTs,
      cleanedMessages, // Use cleaned messages
      botUserId,
      intro,
      downloadResult.attachments,
      downloadResult.failures,
    );

    const result = await runCodexAndPost({
      thread: activeThread,
      prompt,
      outputSchema: blockKitOutputSchema,
      logger,
      threadKey,
      client,
      channel: event.channel,
      threadTs,
      workDir: config.workDir,
      dataDir: config.dataDir,
      sandbox: config.sandbox,
      abortSignal: abortController.signal,
    });

    response = result.response;
    output = result.output;

    // NEW: Generate and post voice response if appropriate
    if (config.voice.enabled && response && output) {
      await maybeGenerateAndPostVoiceResponse({
        responseText: output.text,
        messages, // Use original messages to detect voice request
        voiceConfig: config.voice,
        botToken: config.botToken,
        workDir: config.workDir,
        logger,
        client,
        channel: event.channel,
        threadTs,
        threadKey,
      });
    }
  } catch (error) {
    logger.error('Mention handling failed', { threadKey, error });
    throw error;
  } finally {
    // ... existing cleanup code ...
  }

  // ... existing state persistence code ...
}
```

## Testing the Integration

### Unit Tests

Test voice keyword detection:

```typescript
test('Voice request is detected and cleaned', () => {
  const input = 'Tell me about the weather with voice';
  const { requestsVoice, cleanedText } = extractVoiceRequestFromText(input);
  assert.strictEqual(requestsVoice, true);
  assert.strictEqual(cleanedText, 'Tell me about the weather');
});
```

### Integration Tests

Test end-to-end flow:

```typescript
test('Voice response is generated when requested', async () => {
  const config = {
    voice: {
      enabled: true,
      elevenlabs: {
        apiKey: 'test-key',
        voiceId: 'test-voice',
      },
    },
    // ... other config
  };

  const messages = [{
    text: 'Say hello with voice',
    user: 'U123',
    ts: '1234567890.000001',
  }];

  // Mock ElevenLabs API response
  // ... mock setup ...

  await maybeGenerateAndPostVoiceResponse({
    responseText: 'Hello there!',
    messages,
    voiceConfig: config.voice,
    // ... other params
  });

  // Assert audio file was uploaded
  // ... assertions ...
});
```

### Manual Testing

1. **Enable voice in config**:
   ```bash
   export ALFRED_VOICE_ENABLED=true
   export ELEVENLABS_API_KEY="your-key"
   export ELEVENLABS_VOICE_ID="your-voice-id"
   ```

2. **Test voice request**:
   - Send: `@Alfred What's the weather? Say it with voice`
   - Expect: Text response + MP3 file attachment

3. **Test without voice**:
   - Send: `@Alfred What's the weather?`
   - Expect: Text response only (no audio)

4. **Test voice message input** (future):
   - Send voice message in Slack
   - Expect: Transcription + text response + audio response

## Error Handling

### ElevenLabs API Errors

The voice integration gracefully handles failures:

```typescript
try {
  const voiceResult = await generateVoiceResponse(responseText, options);
  if (!voiceResult) {
    logger.warn('Voice response generation failed', { threadKey });
    return; // Continue without voice response
  }
  // ... upload audio ...
} catch (error) {
  logger.error('Failed to generate or post voice response', { threadKey, error });
  // Don't throw - let text response succeed even if voice fails
}
```

### Slack Upload Errors

If audio upload fails, the text response is still posted:

```typescript
try {
  await client.files.uploadV2({ /* ... */ });
  logger.info('Voice response posted', { threadKey });
} catch (error) {
  logger.error('Audio upload failed', { threadKey, error });
  // Text response already posted - voice is optional
}
```

## Performance Considerations

### Async Voice Generation

Voice generation happens asynchronously after text response:

1. User mentions Alfred
2. Codex processes request (~5-30s)
3. Text response posted immediately
4. Voice generation starts (~2-5s)
5. Audio file uploaded

This ensures users see text response quickly, with voice following shortly after.

### Caching Opportunities

Future optimization: Cache frequently requested responses:

```typescript
const cacheKey = hashText(responseText);
const cached = await voiceCache.get(cacheKey);
if (cached) {
  await uploadCachedAudio(cached);
  return;
}
// Generate new voice response
const audio = await synthesize(responseText);
await voiceCache.set(cacheKey, audio);
```

## Configuration Examples

### Development

```bash
# Minimal voice setup for testing
export ALFRED_VOICE_ENABLED=true
export ELEVENLABS_API_KEY="your-dev-key"
export ELEVENLABS_VOICE_ID="21m00Tcm4TlvDq8ikWAM" # Rachel voice
```

### Production

```bash
# Production voice setup with all options
export ALFRED_VOICE_ENABLED=true
export ELEVENLABS_API_KEY="your-prod-key"
export ELEVENLABS_VOICE_ID="your-custom-voice-id"
export ELEVENLABS_MODEL="eleven_turbo_v2"  # Faster model
```

### Disable Voice

```bash
# Disable voice features entirely
export ALFRED_VOICE_ENABLED=false
# or simply don't set ELEVENLABS_API_KEY
```

## Rollout Strategy

### Phase 1: Opt-in Beta

1. Document voice features in VOICE_SETUP.md ✅
2. Implement core voice infrastructure ✅
3. Add integration hooks in mention handler
4. Test with small group using feature flag
5. Gather feedback on voice quality and UX

### Phase 2: General Availability

1. Enable voice by default for users with ElevenLabs keys
2. Add voice settings command: `/alfred-voice-settings`
3. Allow users to choose voice ID
4. Add per-user voice preferences

### Phase 3: Advanced Features

1. Voice message transcription (Whisper integration)
2. Real-time voice conversations
3. Custom voice cloning per user
4. Voice command shortcuts

## Related Files

- `src/voice/elevenlabs.ts` - ElevenLabs API client
- `src/voice/voiceResponse.ts` - Voice generation utilities
- `src/voice/voiceIntegration.ts` - Slack integration helpers
- `src/voice/audioHandler.ts` - Audio file handling
- `tests/voice.test.ts` - Voice feature tests
- `VOICE_SETUP.md` - User-facing documentation
- `elevenlabs-research.md` - Technical research and architecture
