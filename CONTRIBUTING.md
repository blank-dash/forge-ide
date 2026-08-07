# Contributing to Forge dash

## Checks

Use Node 22, then run:

```bash
npm ci
npm run format:check
npm run lint
npm run typecheck
npm test
npm run smoke
npm run build
```

Keep process boundaries intact: renderer code talks to the host only through `window.forge`; shared code must remain runtime-free. New pure logic needs a test. Settings changes require a migration and a fixture.

## Adding a provider

Add its default configuration to `src/shared/defaults.ts` and its wire-format adapter to `src/main/providers/`. Keep credentials in the encrypted settings store; never commit keys or log request headers.
