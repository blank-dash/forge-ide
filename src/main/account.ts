import type { GithubAccount, Settings } from '@shared/types'

/**
 * Linked service accounts.
 *
 * Forge has no server, so there is nothing to sign in to and no OAuth callback
 * to receive. Linking GitHub therefore means storing a personal access token —
 * which the user creates with exactly the scopes they are willing to grant, can
 * revoke at any time from GitHub, and which is encrypted at rest with the same
 * OS keychain as the provider API keys.
 */

const API = 'https://api.github.com'

/**
 * Publishes the token to the environment so every command the agent or the
 * terminal runs inherits it. `gh` reads GH_TOKEN, git's credential helper and
 * most CI tooling read GITHUB_TOKEN, so both are set.
 */
export function applyAccountEnv(settings: Settings): void {
  const token = settings.github.token.trim()

  if (token) {
    process.env.GH_TOKEN = token
    process.env.GITHUB_TOKEN = token
  } else {
    delete process.env.GH_TOKEN
    delete process.env.GITHUB_TOKEN
  }
}

/**
 * Confirms a token works and reports who it belongs to, so the settings pane
 * can show a linked account rather than an opaque secret the user has to trust.
 */
export async function verifyGithubToken(token: string): Promise<GithubAccount> {
  const trimmed = token.trim()
  if (!trimmed) throw new Error('Paste a token first.')

  const response = await fetch(`${API}/user`, {
    headers: {
      authorization: `Bearer ${trimmed}`,
      accept: 'application/vnd.github+json',
      'user-agent': 'forge-ide'
    }
  })

  if (response.status === 401) {
    throw new Error('GitHub rejected that token. It may be expired or revoked.')
  }
  if (!response.ok) {
    throw new Error(`GitHub replied ${response.status} ${response.statusText}.`)
  }

  const body = (await response.json()) as { login?: string; name?: string; avatar_url?: string }
  if (!body.login) throw new Error('GitHub returned no account for that token.')

  return {
    login: body.login,
    name: body.name ?? '',
    avatarUrl: await inlineAvatar(body.avatar_url),
    // Scopes come back on the response, not in the body. Empty for the
    // fine-grained tokens, which do not report them at all.
    scopes: (response.headers.get('x-oauth-scopes') ?? '')
      .split(',')
      .map((scope) => scope.trim())
      .filter(Boolean)
  }
}

/**
 * Downloads the avatar once and returns it as a data URI.
 *
 * Storing the remote URL instead would mean the renderer calls GitHub every
 * time the profile menu draws — a request carrying the user's IP, on a page
 * whose CSP otherwise permits no outside images at all. One fetch here, at the
 * moment the account is linked, avoids both.
 */
async function inlineAvatar(url: string | undefined): Promise<string> {
  if (!url) return ''

  try {
    // 80px covers the largest place it is drawn, at 2× density.
    const response = await fetch(`${url}${url.includes('?') ? '&' : '?'}s=80`)
    if (!response.ok) return ''

    const type = response.headers.get('content-type') ?? 'image/png'
    if (!type.startsWith('image/')) return ''

    const bytes = Buffer.from(await response.arrayBuffer())
    // Settings are written as JSON on every change; a huge avatar would bloat
    // that file for no visible gain.
    if (bytes.byteLength > 256_000) return ''

    return `data:${type};base64,${bytes.toString('base64')}`
  } catch {
    return ''
  }
}
