# Forge dash v0.6.3

## Speech fix
- Fixed Cyrillic speech corruption on Windows by passing text through explicit UTF-8-safe encoding.
- Russian text still selects an installed Russian Windows voice automatically.
- System speech remains the fallback when a provider has no TTS endpoint.

## Verification
- Typecheck passed.
- Smoke tests passed: 159 tests.
- Live integration checks passed.
