# Voice Integration Setup Guide

This guide explains how to enable and use voice features in Alfred using ElevenLabs.

## Prerequisites

1. **ElevenLabs Account**: Sign up at [elevenlabs.io](https://elevenlabs.io)
2. **API Key**: Get your API key from the ElevenLabs dashboard
3. **Voice ID**: Choose a voice from the [ElevenLabs Voice Library](https://elevenlabs.io/voices)

## Configuration

### Environment Variables

Add the following environment variables to enable voice features:

```bash
# Enable voice features (default: false)
export ALFRED_VOICE_ENABLED=true

# ElevenLabs API credentials
export ELEVENLABS_API_KEY="your-api-key-here"
export ELEVENLABS_VOICE_ID="your-voice-id-here"

# Optional: Specify a model (default: eleven_monolingual_v1)
export ELEVENLABS_MODEL="eleven_turbo_v2"
```

### CLI Flags

Alternatively, pass configuration via CLI flags:

```bash
codex-alfred \
  --appKey xapp-... \
  --botKey xoxb-... \
  --voice-enabled true \
  --elevenlabs-api-key "your-api-key" \
  --elevenlabs-voice-id "your-voice-id"
```

## Usage

### Slack Voice Messages

Alfred can automatically detect and respond to voice messages in Slack:

1. **Send a voice message** in any Slack channel where Alfred is present
2. Alfred will:
   - Download the audio file
   - Transcribe it using Whisper (when implemented)
   - Process your message through Codex
   - Generate both text and voice responses
   - Post the response as text with an audio file attachment

### Request Voice Response

You can request a voice response by including keywords in your message:

```
@Alfred Tell me about the weather with voice
@Alfred Explain this code as voice response
@Alfred Say it with audio
```

Keywords that trigger voice responses:
- "with voice"
- "as voice"
- "voice response"
- "voice reply"
- "say it"
- "speak"
- "audio response"
- "audio reply"

### Voice Response Format

When voice is enabled, Alfred will:
1. Generate a text response (Block Kit formatted)
2. Convert the text to speech using ElevenLabs
3. Save the audio file to the workspace
4. Post both text and audio file to the Slack thread

## Voice Selection

### Choosing the Right Voice

ElevenLabs offers various voices suitable for Alfred:

**Recommended Butler-style voices:**
- **Antoni** - Friendly, professional male voice
- **Adam** - Deep, authoritative male voice
- **Rachel** - Clear, professional female voice
- **Arnold** - Classic butler tone

To find available voices:

```bash
# List all available voices
curl https://api.elevenlabs.io/v1/voices \
  -H "xi-api-key: YOUR_API_KEY"
```

Or visit the [Voice Library](https://elevenlabs.io/voices) to preview voices.

### Custom Voice Cloning

ElevenLabs also supports creating custom voices:

1. Go to the ElevenLabs dashboard
2. Navigate to "Voice Lab"
3. Upload audio samples or use instant voice cloning
4. Copy the generated `voice_id`
5. Update your `ELEVENLABS_VOICE_ID` configuration

## Cost Management

### ElevenLabs Pricing

- **Free Tier**: 10,000 characters/month
- **Starter**: $5/month for 30,000 characters
- **Creator**: $22/month for 100,000 characters
- **Pro**: $99/month for 500,000 characters

### Cost Optimization Tips

1. **Selective Voice**: Voice responses are only generated when:
   - User explicitly requests voice (using keywords)
   - User sends a voice message
   
2. **Text Length Limits**: Responses longer than 5000 characters are truncated for TTS

3. **Disable When Not Needed**: Set `ALFRED_VOICE_ENABLED=false` to disable all voice features

4. **Monitor Usage**: Check your ElevenLabs dashboard regularly to monitor character usage

## Architecture Overview

```
┌─────────────────┐
│  Slack Message  │
└────────┬────────┘
         │
         ├─> Text Input ──────────────┐
         │                            │
         ├─> Voice Message            │
         │   └─> Whisper STT ────────>│
         │                            │
         ▼                            ▼
    ┌────────────────────────────────────┐
    │     Codex Processing (Alfred)       │
    │   (Existing thread management)      │
    └────────────┬───────────────────────┘
                 │
                 ├─> Text Response ──────────┐
                 │                           │
                 ├─> ElevenLabs TTS          │
                 │   └─> Audio File          │
                 │                           │
                 ▼                           ▼
    ┌────────────────────────────────────────┐
    │    Slack Thread (Text + Audio)         │
    └────────────────────────────────────────┘
```

## Implementation Details

### Text-to-Speech Process

1. **Markdown Stripping**: Block Kit markdown is converted to plain text
2. **Length Validation**: Text is checked for ElevenLabs limits
3. **Synthesis**: Text is sent to ElevenLabs API
4. **File Storage**: Audio is saved to the workspace directory
5. **Slack Upload**: Audio file is attached to the response

### Audio File Handling

- Audio files are saved to the workspace directory
- Format: MP3 (44.1kHz, 128kbps)
- Naming: `alfred-response-{timestamp}.mp3`
- Cleanup: Files persist in workspace for user access

## Future Enhancements

### Planned Features

1. **Speech-to-Text Integration**
   - Full Whisper API integration for voice message transcription
   - Support for multiple languages
   - Real-time transcription

2. **Web/Mobile Interface**
   - Progressive Web App for voice interaction
   - Real-time bidirectional voice conversation
   - Push-to-talk interface

3. **Voice Customization**
   - Per-user voice preferences
   - Voice settings (speed, pitch, emphasis)
   - Multiple voice personalities

4. **Advanced Features**
   - Voice activity detection
   - Background noise filtering
   - Multi-language support
   - Voice command shortcuts

## Troubleshooting

### Voice Features Not Working

Check these common issues:

1. **API Key Invalid**
   ```bash
   # Test your API key
   curl https://api.elevenlabs.io/v1/user \
     -H "xi-api-key: YOUR_API_KEY"
   ```

2. **Voice ID Not Found**
   - Verify voice ID exists in your account
   - Check for typos in the voice ID

3. **Quota Exceeded**
   - Check your ElevenLabs dashboard for usage
   - Consider upgrading your plan

4. **Voice Not Enabled**
   ```bash
   # Verify configuration
   echo $ALFRED_VOICE_ENABLED  # should be "true"
   echo $ELEVENLABS_API_KEY    # should have value
   echo $ELEVENLABS_VOICE_ID   # should have value
   ```

### Audio Quality Issues

1. **Low Quality**: Try different ElevenLabs models:
   - `eleven_monolingual_v1` - Standard quality
   - `eleven_turbo_v2` - Faster, good quality
   - `eleven_multilingual_v2` - Multi-language support

2. **Unnatural Speech**: Adjust voice settings (requires API call or dashboard)

3. **Large File Sizes**: Consider using lower bitrate or different format (future enhancement)

## Examples

### Example 1: Simple Voice Request

```
User: @Alfred What's the weather like today? Say it with voice.

Alfred: [Text response] The weather is sunny with a high of 75°F...
        [Audio file attached: alfred-response-1704123456789.mp3]
```

### Example 2: Voice Message Input

```
User: [Sends voice message: "Alfred, can you review this PR?"]

Alfred: [Transcribed] "Can you review this PR?"
        [Text response] I'll review the PR now...
        [Audio file attached: alfred-response-1704123456790.mp3]
```

### Example 3: Programmatic Usage

```typescript
import { createElevenLabsClient } from './src/voice/elevenlabs.js';
import { generateVoiceResponse } from './src/voice/voiceResponse.js';

const client = createElevenLabsClient(
  { apiKey: 'your-key', voiceId: 'your-voice-id' },
  logger
);

const audio = await client.synthesize(
  'Hello, I am Alfred, your AI butler.',
  'voice-id-here'
);
```

## Security & Privacy

### Best Practices

1. **API Key Security**
   - Never commit API keys to version control
   - Use environment variables or secure vaults
   - Rotate keys periodically

2. **Audio Data**
   - Audio files are temporary
   - Stored only in workspace directory
   - Consider cleanup scripts for old files

3. **User Privacy**
   - Voice messages are transcribed via Whisper
   - Audio is not stored permanently by ElevenLabs (check their policy)
   - Users should be informed of voice processing

## Resources

- [ElevenLabs Documentation](https://elevenlabs.io/docs)
- [ElevenLabs API Reference](https://elevenlabs.io/docs/api-reference)
- [Voice Library](https://elevenlabs.io/voices)
- [OpenAI Whisper](https://platform.openai.com/docs/guides/speech-to-text)
- [Alfred Repository](https://github.com/Tiberriver256/codex-alfred)

## Support

For issues or questions:
- File an issue on GitHub
- Check the ElevenLabs documentation
- Review the research document: `elevenlabs-research.md`
