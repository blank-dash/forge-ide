import { useState } from 'react'
import type { GithubLink, Settings } from '@shared/types'
import { useT } from '../i18n'

type Props = {
  draft: Settings
  patch: (partial: Partial<Settings>) => void
}

const TOKEN_URL =
  'https://github.com/settings/tokens/new?scopes=repo,read:org,gist&description=Forge%20IDE'

/**
 * The account pane.
 *
 * Forge runs entirely on your machine — there is no Forge account and no server
 * to sign in to, so "linking GitHub" means storing a token you issue yourself.
 * That is a better deal than OAuth here: you choose the scopes, you can revoke
 * it from GitHub at any moment, and nothing about you passes through us.
 */
export default function AccountSettings({ draft, patch }: Props) {
  const t = useT()
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const linked = draft.github.login !== ''

  const link = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const account = await window.forge.account.verifyGithub(token)
      const github: GithubLink = { ...account, token: token.trim() }
      patch({ github })
      setToken('')
    } catch (caught) {
      setError((caught as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const unlink = (): void => {
    patch({ github: { token: '', login: '', name: '', avatarUrl: '', scopes: [] } })
    setToken('')
    setError(null)
  }

  return (
    <>
      <h3>{t('Account')}</h3>
      <p>
        {t(
          'Who you are inside the app, and the services the agent is allowed to act on your behalf with.'
        )}
      </p>

      <div className="field">
        <label>{t('Your display name')}</label>
        <input
          className="input"
          value={draft.displayName}
          placeholder={t('Your name')}
          onChange={(event) => patch({ displayName: event.target.value })}
        />
        <div className="hint">
          {t(
            'Shown in the profile menu. Stored on this machine only — it is never sent to a model or anywhere else.'
          )}
        </div>
      </div>

      <h4 className="settings-subhead">GitHub</h4>

      {linked ? (
        <div className="account-card">
          {draft.github.avatarUrl ? (
            <img className="account-avatar" src={draft.github.avatarUrl} alt="" />
          ) : (
            <span className="account-avatar placeholder">
              {draft.github.login.charAt(0).toUpperCase()}
            </span>
          )}

          <div className="account-body">
            <div className="account-name">{draft.github.name || draft.github.login}</div>
            <div className="account-meta">
              @{draft.github.login}
              {draft.github.scopes.length > 0 && ` · ${draft.github.scopes.join(', ')}`}
            </div>
          </div>

          <button className="btn ghost" onClick={unlink}>
            {t('Unlink')}
          </button>
        </div>
      ) : (
        <div className="field">
          <label>{t('Personal access token')}</label>
          <div className="row-inline">
            <input
              className="input mono"
              type="password"
              value={token}
              placeholder="ghp_… / github_pat_…"
              spellCheck={false}
              onChange={(event) => setToken(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && token.trim() && !busy) void link()
              }}
            />
            <button className="btn" disabled={!token.trim() || busy} onClick={() => void link()}>
              {busy ? t('Checking…') : t('Link')}
            </button>
          </div>

          {error && <div className="field-error">{error}</div>}

          <div className="hint">
            <button className="link" onClick={() => void window.forge.openExternal(TOKEN_URL)}>
              {t('Create a token on GitHub')}
            </button>{' '}
            {t(
              'with the scopes you are willing to grant, then paste it here. Forge checks it against GitHub and stores it encrypted by your OS keychain, alongside your API keys.'
            )}
          </div>
        </div>
      )}

      <div className="hint" style={{ marginTop: 10 }}>
        {t(
          'Once linked, every command the agent runs sees GH_TOKEN and GITHUB_TOKEN, so `gh` and `git push` work without asking you to authenticate again. Revoke the token on GitHub to cut that off instantly.'
        )}
      </div>

      <h4 className="settings-subhead">Google</h4>
      <div className="hint">
        {t(
          'Not available. Google sign-in needs a registered OAuth client and a server to receive the callback, and Forge has neither by design — nothing about you leaves this machine. To let the agent reach a Google service, add its MCP server under MCP servers instead.'
        )}
      </div>
    </>
  )
}
