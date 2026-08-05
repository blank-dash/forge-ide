# Forge dash v0.7.0

## Highlights
- **Per-Conversation Model Selection**: Models are now selected and persisted independently for each chat session. Changing a model in one conversation no longer affects other active or background chats.
- **Chat-Scoped Live Mode & Hands-Free Conversation**: Live mode screen sharing, input tools, automatic speech, and microphone listening are strictly scoped to the conversation that initiated Live mode.
- **Automatic Speech Input & Fallback**:
  - Live mode now announces: *"Live mode is enabled. What shall we do?"* and starts listening automatically.
  - Automatic fallback to configured speech-to-text (Whisper/STT) providers when a chat provider (like Kimi / Lenec) lacks `/audio/transcriptions`.
  - Automatic fallback to system voices when a provider lacks `/audio/speech`.
  - Automatic Cyrillic UTF-8 encoding fix ensuring clear Russian speech synthesis without symbol corruption.
- **Prompt Action Buttons**: Added `Copy`, `Send again`, and `Delete` action buttons directly under user messages in the chat panel.
- **DeepSeek Integration**: Built-in DeepSeek provider preset with `DeepSeek Chat` and `DeepSeek Reasoner` models.
- **New Skills**: Added `voice-conversation`, `screen-observation`, and `hearing-fallback` skill instruction packs.

## Verification
- `npm run typecheck`
- `npm run smoke` (159 passed)
- `npm run check:live`
- `npm run build`
