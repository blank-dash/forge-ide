import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync
} from 'node:fs'
import path from 'node:path'
import { app, safeStorage } from 'electron'
import { BUILTIN_PROVIDERS, DEFAULT_SETTINGS } from '@shared/defaults'
import type { ProviderConfig, Settings } from '@shared/types'

const ENCRYPTED_PREFIX = 'enc:v1:'

/**
 * Settings live in the OS user-data directory. API keys are encrypted with
 * Electron's safeStorage (DPAPI on Windows, Keychain on macOS, libsecret on
 * Linux) whenever the platform supports it, and stored in the clear otherwise
 * — with `keysEncrypted` telling the UI which case applies.
 */
export class SettingsStore {
  private cache: Settings = DEFAULT_SETTINGS

  get file(): string {
    return path.join(app.getPath('userData'), 'settings.json')
  }

  /** Last known-good copy, kept so a corrupt write cannot cost the user their config. */
  private get backupFile(): string {
    return `${this.file}.bak`
  }

  get keysEncrypted(): boolean {
    try {
      return safeStorage.isEncryptionAvailable()
    } catch {
      return false
    }
  }

  get(): Settings {
    return this.cache
  }

  /**
   * Falls back to the backup before it falls back to defaults. Silently
   * resetting someone's providers and API keys because one byte of JSON went
   * bad is not an acceptable failure mode.
   */
  load(): Settings {
    const primary = this.readFile(this.file)
    if (primary) {
      this.cache = migrate(primary)
      return this.cache
    }

    const backup = this.readFile(this.backupFile)
    if (backup) {
      this.cache = migrate(backup)
      // Put the good copy back so the next read is clean.
      this.persist()
      return this.cache
    }

    this.cache = DEFAULT_SETTINGS
    return this.cache
  }

  set(next: Settings): Settings {
    this.cache = migrate(next)
    this.persist()
    return this.cache
  }

  /** The exact bytes on disk, for the export button. */
  serialize(): string {
    return JSON.stringify(this.encrypted(), null, 2)
  }

  private readFile(target: string): Partial<Settings> | null {
    try {
      if (!existsSync(target)) return null
      const parsed = JSON.parse(readFileSync(target, 'utf8')) as Partial<Settings>
      // A truncated write can still parse as valid JSON of the wrong shape.
      return parsed && typeof parsed === 'object' ? parsed : null
    } catch {
      return null
    }
  }

  /**
   * Written synchronously and atomically.
   *
   * Synchronous because an async write can be lost if the process is killed in
   * the moment after a model is added — which is exactly when it hurts. Atomic
   * because a half-written settings file is worse than a stale one.
   */
  private persist(): void {
    const payload = JSON.stringify(this.encrypted(), null, 2)
    const target = this.file
    const temporary = `${target}.tmp`

    try {
      mkdirSync(path.dirname(target), { recursive: true })

      if (existsSync(target)) {
        copyFileSync(target, this.backupFile)
      }

      writeFileSync(temporary, payload, 'utf8')
      renameSync(temporary, target)
    } catch (error) {
      console.error('[settings] could not save', error)
    }
  }

  private encrypted(): Settings {
    return {
      ...this.cache,
      providers: this.cache.providers.map((provider) => ({
        ...provider,
        apiKey: encryptKey(provider.apiKey)
      }))
    }
  }
}

function encryptKey(value: string): string {
  if (!value || value.startsWith(ENCRYPTED_PREFIX)) return value
  try {
    if (!safeStorage.isEncryptionAvailable()) return value
    return ENCRYPTED_PREFIX + safeStorage.encryptString(value).toString('base64')
  } catch {
    return value
  }
}

function decryptKey(value: string): string {
  if (!value?.startsWith(ENCRYPTED_PREFIX)) return value ?? ''
  try {
    return safeStorage.decryptString(Buffer.from(value.slice(ENCRYPTED_PREFIX.length), 'base64'))
  } catch {
    // Happens when the OS keychain changed (new machine, restored profile).
    return ''
  }
}

/** Fields older builds wrote that newer ones replaced. */
interface LegacySettings {
  permissionMode?: 'plan' | 'default' | 'acceptEdits' | 'bypass'
  thinkingBudget?: number
  /** Themes were a two-value toggle before the presets existed. */
  theme?: string
}

function migrateModes(input: Partial<Settings> & LegacySettings): Partial<Settings> {
  if (!input.permissionMode || input.mode) return input

  switch (input.permissionMode) {
    case 'plan':
      return { ...input, mode: 'chat', readOnly: true, editApproval: 'review', commandApproval: 'ask' }
    case 'default':
      return { ...input, mode: 'agent', editApproval: 'ask', commandApproval: 'ask' }
    case 'acceptEdits':
      return { ...input, mode: 'agent', editApproval: 'review', commandApproval: 'ask' }
    case 'bypass':
      return { ...input, mode: 'agent', editApproval: 'auto', commandApproval: 'auto' }
  }
}

/**
 * Fills in fields added by newer versions and re-merges built-in providers so
 * upgrades pick up new presets without clobbering user edits.
 */
function migrate(rawInput: Partial<Settings> & LegacySettings): Settings {
  const raw = rawInput
  const input = migrateModes(raw as Partial<Settings> & LegacySettings)

  // A raw thinking budget became the "effort" preset.
  if (raw.thinkingBudget !== undefined && input.effort === undefined) {
    input.effort =
      raw.thinkingBudget <= 0
        ? 'off'
        : raw.thinkingBudget < 8_000
          ? 'low'
          : raw.thinkingBudget < 16_000
            ? 'medium'
            : 'high'
  }
  const stored = input.providers ?? []
  const byId = new Map(stored.map((provider) => [provider.id, provider]))

  const providers: ProviderConfig[] = BUILTIN_PROVIDERS.map((builtin) => {
    const saved = byId.get(builtin.id)
    byId.delete(builtin.id)
    if (!saved) return builtin
    return {
      ...builtin,
      ...saved,
      builtin: true,
      apiKey: decryptKey(saved.apiKey),
      headers: saved.headers ?? builtin.headers,
      // `?? ` not `.length ?` — an intentionally emptied model list must stick.
      models: saved.models ?? builtin.models
    }
  })

  // Anything left is a user-defined provider.
  for (const custom of byId.values()) {
    providers.push({
      ...custom,
      builtin: false,
      apiKey: decryptKey(custom.apiKey),
      headers: custom.headers ?? {},
      models: custom.models ?? []
    })
  }

  // 'dark' was the only dark option before the presets landed.
  const theme: Settings['theme'] =
    (raw.theme as string) === 'dark' ? 'warm-dark' : (input.theme ?? DEFAULT_SETTINGS.theme)

  return {
    ...DEFAULT_SETTINGS,
    ...input,
    theme,
    disabledSkills: input.disabledSkills ?? [],
    providers,
    allowRules: input.allowRules ?? [],
    denyRules: input.denyRules ?? [],
    externalRoots: input.externalRoots ?? [],
    layout: { ...DEFAULT_SETTINGS.layout, ...(input.layout ?? {}) },
    mcpServers: (input.mcpServers ?? []).map((server) => ({
      ...server,
      args: server.args ?? [],
      env: server.env ?? {},
      headers: server.headers ?? {},
      autoApproveTools: server.autoApproveTools ?? [],
      url: server.url ?? '',
      command: server.command ?? ''
    })),
    recentWorkspaces: (input.recentWorkspaces ?? []).slice(0, 10)
  }
}
