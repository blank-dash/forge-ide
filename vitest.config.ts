import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: { alias: { '@shared': new URL('./src/shared', import.meta.url).pathname } },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      include: ['src/shared/paths.ts', 'src/main/agent/context.ts'],
      exclude: ['src/shared/skills.ts'],
      thresholds: { lines: 80, functions: 80, statements: 80, branches: 65 }
    }
  }
})
