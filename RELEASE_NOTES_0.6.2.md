# Forge dash v0.6.2

## Live voice update
- Live mode now starts from the current chat and keeps the conversation owner.
- The agent receives screen access only in the owning conversation.
- Microphone listening starts automatically after Live is enabled.
- Live announces: “Live mode is enabled. What shall we do?”
- Text replies remain available when speech recognition or TTS is unavailable.

## Speech fixes
- Russian text automatically selects an installed Russian Windows voice.
- Providers without `/audio/speech` fall back to the computer's voice.
- Added voice, screen-observation, and hearing-fallback skills.

## Providers
- DeepSeek remains available as a built-in OpenAI-compatible provider with Chat and Reasoner models.

## Verification
- Typecheck passed.
- Smoke tests passed: 159 tests.
- Live integration checks passed.
- Production build passed.
