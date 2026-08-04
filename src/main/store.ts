import { promises as fs } from 'node:fs'
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
  private writeQueue: Promise<void> = Promise.resolve()

  get file(): string {
    return path.join(app.getPath('userData'), 'settings.json')
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

  async load(): Promise<Settings> {
    const raw = await fs.readFile(this.file, 'utf8').catch(() => null)
    if (!raw) {
      this.cache = DEFAULT_SETTINGS
      return this.cache
    }

    try {
      const parsed = JSON.parse(raw) as Partial<Settings>
      this.cache = migrate(parsed)
    } catch {
      // A corrupt settings file must not brick the app.
      this.cache = DEFAULT_SETTINGS
    }
    return this.cache
  }

  set(next: Settings): Settings {
    this.cache = migrate(next)
    this.persist()
    return this.cache
  }

  patch(partial: Partial<Settings>): Settings {
    return this.set({ ...this.cache, ...partial })
  }

  private persist(): void {
    const snapshot = this.cache
    // Serialise writes so two rapid updates cannot interleave.
    this.writeQueue = this.writeQueue.then(async () => {
      const payload: Settings = {
        ...snapshot,
        providers: snapshot.providers.map((provider) => ({
          ...provider,
          apiKey: encryptKey(provider.apiKey)
        }))
      }
      await fs.mkdir(path.dirname(this.file), { recursive: true })
      await fs.writeFile(this.file, JSON.stringify(payload, null, 2), 'utf8')
    })
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
}

function migrateModes(input: Partial<Settings> & LegacySettings): Partial<Settings> {
  if (!input.permissionMode || input.mode) return input

  switch (input.permissionMode) {
    case 'plan':
      return { ...input, mode: 'chat', editApproval: 'review', commandApproval: 'ask' }
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
function migrate(raw: Partial<Settings> & LegacySettings): Settings {
  const input = migrateModes(raw)

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

  return {
    ...DEFAULT_SETTINGS,
    ...input,
    providers,
    allowRules: input.allowRules ?? [],
    denyRules: input.denyRules ?? [],
    externalRoots: input.externalRoots ?? [],
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
