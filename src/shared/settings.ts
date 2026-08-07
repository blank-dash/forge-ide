import { BUILTIN_PROVIDERS, DEFAULT_SETTINGS } from './defaults'
import type { ProviderConfig, Settings, ThemeName } from './types'

export const SETTINGS_SCHEMA_VERSION = 1

interface LegacySettings {
  permissionMode?: 'plan' | 'default' | 'acceptEdits' | 'bypass'
  thinkingBudget?: number
  theme?: string
  providers?: ProviderConfig[]
  activeModel?: string
  mode?: Settings['mode']
  readOnly?: boolean
  dryRun?: boolean
  bypassPermissions?: boolean
  editApproval?: Settings['editApproval']
  commandApproval?: Settings['commandApproval']
  stance?: Settings['stance']
  allowRules?: string[]
  denyRules?: string[]
  externalRoots?: string[]
  mcpServers?: Settings['mcpServers']
  disabledSkills?: string[]
  language?: Settings['language']
  displayName?: string
  github?: Settings['github']
  voice?: Settings['voice']
  prompts?: Settings['prompts']
  layout?: Settings['layout']
  accent?: string
  uiScale?: number
  editorFontSize?: number
  chatFontSize?: number
  fontFamily?: string
  maxOutputTokens?: number
  maxAgentTurns?: number
  maxAttempts?: number
  turnTimeoutMs?: number
  temperature?: number
  effort?: Settings['effort']
  providerFirstByteTimeoutMs?: number
  providerChunkTimeoutMs?: number
  maxTurnCostUsd?: number
  maxSessionCostUsd?: number
  customInstructions?: string
  showThinking?: boolean
  autoSaveSessions?: boolean
  setupCompleted?: boolean
  recentWorkspaces?: string[]
  [key: string]: unknown
}

export function validateProviderIds(providers: ProviderConfig[]): void {
  const providerIds = new Set<string>()
  for (const provider of providers) {
    if (!provider.id.trim()) throw new Error('Every provider needs an id.')
    if (providerIds.has(provider.id))
      throw new Error(`Provider id "${provider.id}" is used more than once.`)
    providerIds.add(provider.id)

    const modelIds = new Set<string>()
    for (const model of provider.models) {
      if (!model.id.trim()) throw new Error(`Every model in "${provider.id}" needs an id.`)
      if (modelIds.has(model.id))
        throw new Error(`Model id "${model.id}" is duplicated in provider "${provider.id}".`)
      modelIds.add(model.id)
    }
  }
}

export function nextProviderId(base: string, providers: ProviderConfig[]): string {
  const used = new Set(providers.map((provider) => provider.id))
  if (!used.has(base)) return base
  let suffix = 2
  while (used.has(`${base}-${suffix}`)) suffix++
  return `${base}-${suffix}`
}

export function migrateSettings(
  value: unknown,
  decrypt: (secret: string) => string = (secret) => secret
): Settings {
  const raw = isRecord(value) ? ({ ...value } as LegacySettings) : {}
  const input = migrateModes(raw)
  const effort = migrateEffort(raw, input)
  const providers = mergeProviders(input.providers, decrypt)
  validateProviderIds(providers)

  return {
    ...DEFAULT_SETTINGS,
    ...input,
    schemaVersion: SETTINGS_SCHEMA_VERSION,
    effort,
    theme:
      raw.theme === 'dark'
        ? 'warm-dark'
        : ((input.theme as ThemeName | undefined) ?? DEFAULT_SETTINGS.theme),
    providers,
    disabledSkills: input.disabledSkills ?? [],
    allowRules: input.allowRules ?? [],
    denyRules: input.denyRules ?? [],
    externalRoots: input.externalRoots ?? [],
    layout: { ...DEFAULT_SETTINGS.layout, ...(input.layout ?? {}) },
    voice: { ...DEFAULT_SETTINGS.voice, ...(input.voice ?? {}) },
    prompts: input.prompts ?? DEFAULT_SETTINGS.prompts,
    github: {
      ...DEFAULT_SETTINGS.github,
      ...(input.github ?? {}),
      token: decrypt(input.github?.token ?? ''),
      scopes: input.github?.scopes ?? []
    },
    maxAgentTurns: clampInteger(input.maxAgentTurns ?? DEFAULT_SETTINGS.maxAgentTurns, 20, 500),
    maxAttempts: clampInteger(input.maxAttempts ?? DEFAULT_SETTINGS.maxAttempts, 1, 10),
    turnTimeoutMs: clampInteger(
      input.turnTimeoutMs ?? DEFAULT_SETTINGS.turnTimeoutMs,
      60_000,
      3_600_000
    ),
    providerFirstByteTimeoutMs: clampInteger(
      input.providerFirstByteTimeoutMs ?? DEFAULT_SETTINGS.providerFirstByteTimeoutMs,
      5_000,
      300_000
    ),
    providerChunkTimeoutMs: clampInteger(
      input.providerChunkTimeoutMs ?? DEFAULT_SETTINGS.providerChunkTimeoutMs,
      10_000,
      600_000
    ),
    maxTurnCostUsd: clampMoney(input.maxTurnCostUsd ?? DEFAULT_SETTINGS.maxTurnCostUsd),
    maxSessionCostUsd: clampMoney(input.maxSessionCostUsd ?? DEFAULT_SETTINGS.maxSessionCostUsd),
    dryRun: input.dryRun ?? DEFAULT_SETTINGS.dryRun,
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

function migrateModes(raw: LegacySettings): LegacySettings {
  if (!raw.permissionMode || raw.mode) return raw
  if (raw.permissionMode === 'plan')
    return { ...raw, mode: 'chat', readOnly: true, editApproval: 'review', commandApproval: 'ask' }
  if (raw.permissionMode === 'default')
    return { ...raw, mode: 'agent', editApproval: 'ask', commandApproval: 'ask' }
  if (raw.permissionMode === 'acceptEdits')
    return { ...raw, mode: 'agent', editApproval: 'review', commandApproval: 'ask' }
  return { ...raw, mode: 'agent', editApproval: 'auto', commandApproval: 'auto' }
}

function migrateEffort(raw: LegacySettings, input: LegacySettings): Settings['effort'] {
  if (input.effort) return input.effort
  const budget = raw.thinkingBudget
  if (budget === undefined || budget <= 0) return 'off'
  if (budget < 8_000) return 'low'
  if (budget < 16_000) return 'medium'
  return 'high'
}

function mergeProviders(
  stored: ProviderConfig[] | undefined,
  decrypt: (secret: string) => string
): ProviderConfig[] {
  const byId = new Map((stored ?? []).map((provider) => [provider.id, provider]))
  const providers = BUILTIN_PROVIDERS.map((builtin) => {
    const saved = byId.get(builtin.id)
    byId.delete(builtin.id)
    if (!saved) return builtin
    return {
      ...builtin,
      ...saved,
      builtin: true,
      apiKey: decrypt(saved.apiKey),
      headers: saved.headers ?? builtin.headers,
      models: saved.models ?? builtin.models
    }
  })
  for (const custom of byId.values()) {
    providers.push({
      ...custom,
      builtin: false,
      apiKey: decrypt(custom.apiKey),
      headers: custom.headers ?? {},
      models: custom.models ?? []
    })
  }
  return providers
}

function clampMoney(value: number): number {
  return Math.min(10_000, Math.max(0, Math.round((Number.isFinite(value) ? value : 0) * 100) / 100))
}

function clampInteger(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(Number.isFinite(value) ? value : min)))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}
