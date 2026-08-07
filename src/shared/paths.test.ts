import { describe, expect, it } from 'vitest'
import { basename, dirname, ext, isInside, toPosix } from './paths'
import { DEFAULT_SETTINGS } from './defaults'
import { migrateSettings, nextProviderId, validateProviderIds } from './settings'

describe('paths', () => {
  it('handles Windows, UNC and mixed separators', () => {
    expect(basename('D:\\forge-ide\\src\\App.tsx')).toBe('App.tsx')
    expect(basename('\\\\server\\share\\file.txt')).toBe('file.txt')
    expect(dirname('C:\\src\\main\\index.ts')).toBe('C:/src/main')
    expect(ext('/tmp/.env')).toBe('')
    expect(toPosix('src\\main/index.ts')).toBe('src/main/index.ts')
    expect(isInside('C:\\workspace', 'c:/workspace/src/app.ts')).toBe(true)
    expect(isInside('/workspace', '/workspace-other/file')).toBe(false)
  })
})

describe('settings', () => {
  it('migrates legacy permission and thinking fields', () => {
    const result = migrateSettings({ permissionMode: 'plan', thinkingBudget: 9000 })
    expect(result.schemaVersion).toBe(1)
    expect(result.mode).toBe('chat')
    expect(result.readOnly).toBe(true)
    expect(result.effort).toBe('medium')
  })

  it('rejects duplicate ids and generates a free provider id', () => {
    expect(() =>
      validateProviderIds([DEFAULT_SETTINGS.providers[0], DEFAULT_SETTINGS.providers[0]])
    ).toThrow()
    const providers = [
      { ...DEFAULT_SETTINGS.providers[0], id: 'custom' },
      { ...DEFAULT_SETTINGS.providers[0], id: 'custom-2' }
    ]
    expect(nextProviderId('custom', providers)).toBe('custom-3')
  })
})
