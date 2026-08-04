import type { CommandApproval, EditApproval, PermissionRequest } from '@shared/types'

/** Rule namespace shown to the user, e.g. `Bash(npm test *)`. */
const NAMESPACE_BY_TOOL: Record<string, string> = {
  run_command: 'Bash',
  edit_file: 'Edit',
  write_file: 'Write',
  delete_file: 'Delete',
  read_file: 'Read',
  list_dir: 'List',
  glob: 'Glob',
  grep: 'Grep'
}

export type Verdict = 'allow' | 'deny' | 'ask'

export interface PermissionInput {
  readOnly: boolean
  bypassPermissions: boolean
  editApproval: EditApproval
  commandApproval: CommandApproval
  allowRules: string[]
  denyRules: string[]
  request: Omit<PermissionRequest, 'id'>
  /** The value a rule pattern is matched against: a command line or a path. */
  target: string
}

export function evaluatePermission(input: PermissionInput): Verdict {
  const { request, target } = input

  // Deny rules are absolute and are checked before anything else.
  if (matchesAny(input.denyRules, request.toolName, target)) return 'deny'

  // Read-only is a hard boundary; no allow rule can unlock a mutation. Reading
  // a file outside the workspace is still the user's call to make, though.
  if (input.readOnly && request.kind !== 'external') return 'deny'

  // Bypass is deliberately last of the absolutes: deny rules and read-only
  // still win, so a boundary someone set on purpose is not undone by it.
  if (input.bypassPermissions) return 'allow'

  switch (request.kind) {
    case 'external':
      // A new location outside the workspace is always the user's call.
      return 'ask'

    case 'shell':
      if (input.commandApproval === 'auto') return 'allow'
      return matchesAny(input.allowRules, request.toolName, target) ? 'allow' : 'ask'

    case 'mcp':
      return matchesAny(input.allowRules, request.toolName, target) ? 'allow' : 'ask'

    case 'edit':
    case 'write':
      if (input.editApproval === 'auto') return 'allow'
      return matchesAny(input.allowRules, request.toolName, target) ? 'allow' : 'ask'
  }
}

export function matchesAny(rules: string[], toolName: string, target: string): boolean {
  return rules.some((rule) => matchesRule(rule, toolName, target))
}

/**
 * A rule is `Namespace(pattern)`; a bare `Namespace` matches every target.
 * `*` in the pattern matches any run of characters, `?` matches one, and `**`
 * additionally crosses path separators.
 */
export function matchesRule(rule: string, toolName: string, target: string): boolean {
  const namespace = NAMESPACE_BY_TOOL[toolName] ?? mcpNamespace(toolName)
  if (!namespace) return false

  const trimmed = rule.trim()
  const open = trimmed.indexOf('(')

  if (open === -1) return trimmed === namespace || trimmed === '*'

  const ruleNamespace = trimmed.slice(0, open).trim()
  if (ruleNamespace !== namespace && ruleNamespace !== '*') return false

  const close = trimmed.lastIndexOf(')')
  const pattern = trimmed.slice(open + 1, close === -1 ? undefined : close).trim()
  if (!pattern || pattern === '*' || pattern === '**') return true

  return globToRegex(pattern).test(normalise(target))
}

/** MCP tools are namespaced by their own qualified name: `mcp__server__tool`. */
function mcpNamespace(toolName: string): string | null {
  return toolName.startsWith('mcp__') ? toolName : null
}

function normalise(value: string): string {
  return value.replace(/\\/g, '/').trim()
}

const regexCache = new Map<string, RegExp>()

function globToRegex(pattern: string): RegExp {
  const cached = regexCache.get(pattern)
  if (cached) return cached

  let body = ''
  const source = normalise(pattern)

  for (let i = 0; i < source.length; i++) {
    const char = source[i]
    if (char === '*') {
      if (source[i + 1] === '*') {
        body += '.*'
        i++
        if (source[i + 1] === '/') i++
      } else {
        body += '[^/]*'
      }
    } else if (char === '?') {
      body += '.'
    } else {
      body += char.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    }
  }

  const regex = new RegExp(`^${body}$`)
  regexCache.set(pattern, regex)
  return regex
}

/** The string a rule is matched against for a given request. */
export function ruleTarget(request: Omit<PermissionRequest, 'id'>): string {
  if (request.kind === 'shell') return request.detail.split('\n')[0]
  if (request.kind === 'mcp') return request.title
  return request.title.replace(/^(Edit|Create|Overwrite|Delete)\s+/, '')
}
