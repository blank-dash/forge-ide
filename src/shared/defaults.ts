import type { ModelConfig, ProviderConfig, Settings } from './types'

const m = (
  id: string,
  label: string,
  contextWindow: number,
  maxOutputTokens: number,
  pricing?: ModelConfig['pricing'],
  extra: Partial<ModelConfig> = {}
): ModelConfig => ({
  id,
  label,
  contextWindow,
  maxOutputTokens,
  supportsTools: true,
  supportsVision: true,
  supportsThinking: false,
  pricing,
  ...extra
})

/**
 * Built-in presets. These are starting points only — every field is editable
 * in Settings, and users can add fully custom providers pointing at any
 * OpenAI-, Anthropic-, or Gemini-compatible endpoint.
 */
export const BUILTIN_PROVIDERS: ProviderConfig[] = [
  {
    id: 'anthropic',
    name: 'Anthropic',
    kind: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    apiKey: '',
    headers: {},
    builtin: true,
    enabled: true,
    models: [
      m('claude-opus-4-5', 'Claude Opus 4.5', 200_000, 64_000, { input: 5, output: 25 }, { supportsThinking: true }),
      m('claude-sonnet-4-5', 'Claude Sonnet 4.5', 200_000, 64_000, { input: 3, output: 15 }, { supportsThinking: true }),
      m('claude-haiku-4-5', 'Claude Haiku 4.5', 200_000, 32_000, { input: 1, output: 5 })
    ]
  },
  {
    id: 'openai',
    name: 'OpenAI',
    kind: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    apiKey: '',
    headers: {},
    builtin: true,
    enabled: true,
    models: [
      m('gpt-4.1', 'GPT-4.1', 1_000_000, 32_000, { input: 2, output: 8 }),
      m('gpt-4.1-mini', 'GPT-4.1 mini', 1_000_000, 32_000, { input: 0.4, output: 1.6 }),
      m('o4-mini', 'o4-mini', 200_000, 100_000, { input: 1.1, output: 4.4 }, { supportsThinking: true })
    ]
  },
  {
    id: 'google',
    name: 'Google Gemini',
    kind: 'google',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    apiKey: '',
    headers: {},
    builtin: true,
    enabled: true,
    models: [
      m('gemini-2.5-pro', 'Gemini 2.5 Pro', 1_000_000, 65_000, { input: 1.25, output: 10 }, { supportsThinking: true }),
      m('gemini-2.5-flash', 'Gemini 2.5 Flash', 1_000_000, 65_000, { input: 0.3, output: 2.5 })
    ]
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    kind: 'openai',
    baseUrl: 'https://openrouter.ai/api/v1',
    apiKey: '',
    headers: { 'HTTP-Referer': 'https://localhost', 'X-Title': 'Forge' },
    builtin: true,
    enabled: false,
    models: [
      m('anthropic/claude-sonnet-4.5', 'Claude Sonnet 4.5 (OR)', 200_000, 64_000),
      m('deepseek/deepseek-chat', 'DeepSeek V3 (OR)', 128_000, 8_000),
      m('qwen/qwen3-coder', 'Qwen3 Coder (OR)', 262_000, 32_000)
    ]
  },
  {
    id: 'ollama',
    name: 'Ollama (local)',
    kind: 'openai',
    baseUrl: 'http://localhost:11434/v1',
    apiKey: 'ollama',
    headers: {},
    builtin: true,
    enabled: false,
    models: [
      m('qwen2.5-coder:14b', 'Qwen2.5 Coder 14B', 32_000, 8_000, undefined, { supportsVision: false }),
      m('llama3.1:8b', 'Llama 3.1 8B', 128_000, 8_000, undefined, { supportsVision: false })
    ]
  },
  {
    id: 'lmstudio',
    name: 'LM Studio (local)',
    kind: 'openai',
    baseUrl: 'http://localhost:1234/v1',
    apiKey: 'lm-studio',
    headers: {},
    builtin: true,
    enabled: false,
    models: [m('local-model', 'Loaded model', 32_000, 8_000, undefined, { supportsVision: false })]
  }
]

export const DEFAULT_SETTINGS: Settings = {
  providers: BUILTIN_PROVIDERS,
  activeModel: 'anthropic:claude-sonnet-4-5',
  mode: 'agent',
  readOnly: false,
  bypassPermissions: false,
  editApproval: 'review',
  commandApproval: 'ask',
  stance: 'default',
  allowRules: [],
  denyRules: [],
  externalRoots: [],
  mcpServers: [],
  disabledSkills: [],
  theme: 'warm-dark',
  accent: '#d97757',
  editorFontSize: 13,
  chatFontSize: 13,
  // Rounded, low-contrast monospace faces first — they read softer over long
  // sessions than the sharp grotesques most editors default to.
  fontFamily:
    "'Maple Mono', 'Comic Mono', 'Cascadia Code', 'JetBrains Mono', 'SF Mono', Consolas, monospace",
  maxOutputTokens: 16_000,
  temperature: 0,
  effort: 'off',
  customInstructions: '',
  showThinking: true,
  autoSaveSessions: true,
  setupCompleted: false,
  layout: {
    sidebarWidth: 240,
    chatWidth: 470,
    chatSidebarWidth: 262,
    terminalHeight: 220,
    terminalOpen: false,
    sidePanel: 'explorer'
  },
  recentWorkspaces: []
}

export const DEFAULT_CONTEXT_THRESHOLD = 0.75
