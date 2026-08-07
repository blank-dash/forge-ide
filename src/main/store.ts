import path from 'node:path'
import { app, safeStorage } from 'electron'
import { readSettingsDisk, writeSettingsDisk } from './settings-disk'
import { DEFAULT_SETTINGS } from '@shared/defaults'
import { migrateSettings, validateProviderIds } from '@shared/settings'
import type { Settings } from '@shared/types'

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
    const loaded = readSettingsDisk(this.file)
    this.cache = loaded ? migrateSettings(loaded.value, decryptKey) : DEFAULT_SETTINGS
    return this.cache
  }

  set(next: Settings): Settings {
    validateProviderIds(next.providers)
    this.cache = migrateSettings(next, decryptKey)
    this.persist()
    return this.cache
  }

  /** The exact bytes on disk, for the export button. */
  serialize(): string {
    return JSON.stringify(this.encrypted(), null, 2)
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
    try {
      writeSettingsDisk(target, payload)
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
      })),
      // A GitHub token is as sensitive as a provider key, so it gets the same
      // treatment rather than sitting in plain text beside them.
      github: { ...this.cache.github, token: encryptKey(this.cache.github.token) }
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
