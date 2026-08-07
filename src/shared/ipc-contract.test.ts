import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '../..')
const preload = readFileSync(path.join(root, 'src/preload/index.ts'), 'utf8')
const ipc = readFileSync(path.join(root, 'src/main/ipc.ts'), 'utf8')

function channels(source: string, expression: RegExp): Set<string> {
  return new Set([...source.matchAll(expression)].map((match) => match[1]))
}

describe('IPC contract', () => {
  it('keeps preload invocations and main handlers in sync', () => {
    const invoked = channels(preload, /call[^\n]*\(\s*['"]([^'"]+)['"]/g)
    const handled = channels(ipc, /handle\(\s*['"]([^'"]+)['"]/g)
    expect([...invoked].filter((channel) => !handled.has(channel))).toEqual([])
    expect([...handled].filter((channel) => !invoked.has(channel))).toEqual([])
  })
})
