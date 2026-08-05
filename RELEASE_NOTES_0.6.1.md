# Forge dash v0.6.1

## Highlights
- Live mode is now attached to the conversation that started it.
- Live screen tools and automatic speech are isolated from other chats.
- Added text fallback when speech recognition or speech output is unavailable.
- Added `Copy`, `Send again`, and `Delete` actions under user prompts.
- Added built-in DeepSeek provider with Chat and Reasoner models.
- Preserved compatibility with existing Live checks and conversations.

## Fixes
- Switching chats no longer grants the new chat Live screen-control tools.
- Live replies are routed back to the owning conversation.
- Kimi and other chat-only providers no longer appear to support speech endpoints.
- Prompt actions operate on the selected conversation ID.
- Release metadata and package lock are synchronized to `0.6.1`.

## Verification
- `npm run typecheck`
- `npm run smoke` (`159 passed, 0 failed`)
- `npm run build`
- `npm audit --omit=optional` reviewed; remaining advisories are tracked in the release notes and require breaking upgrades of Electron/build tooling.
