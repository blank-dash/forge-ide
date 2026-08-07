import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readSettingsDisk, writeSettingsDisk } from './settings-disk'

const roots: string[] = []
const temporaryFile = (): string => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'forge-settings-'))
  roots.push(root)
  return path.join(root, 'settings.json')
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('settings disk recovery', () => {
  it('restores the backup when the primary file is truncated', () => {
    const file = temporaryFile()
    writeSettingsDisk(file, JSON.stringify({ version: 1 }))
    writeSettingsDisk(file, JSON.stringify({ version: 2 }))
    writeFileSync(file, '{"version":', 'utf8')

    expect(readSettingsDisk(file)).toEqual({ value: { version: 1 }, source: 'backup' })
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ version: 1 })
  })

  it('returns null when neither copy is readable', () => {
    expect(readSettingsDisk(temporaryFile())).toBeNull()
  })
})
