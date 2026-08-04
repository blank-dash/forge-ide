import { useStore } from '../store'

export default function StatusBar() {
  const bootstrap = useStore((state) => state.bootstrap)
  const settings = useStore((state) => state.settings)
  const totals = useStore((state) => state.totals)
  const running = useStore((state) => state.running)
  const tabs = useStore((state) => state.tabs)
  const activeTab = useStore((state) => state.activeTab)
  const git = useStore((state) => state.git)
  const mcp = useStore((state) => state.mcp)
  const changes = useStore((state) => state.changes)
  const patchUi = useStore((state) => state.patchUi)

  const current = tabs.find((tab) => tab.path === activeTab)
  const dirty = tabs.filter((tab) => tab.content !== tab.savedContent).length
  const mcpReady = mcp.filter((server) => server.state === 'ready').length
  const mcpBroken = mcp.filter((server) => server.state === 'error').length

  return (
    <div className="statusbar">
      <button onClick={() => patchUi({ sidePanel: 'explorer' })}>{bootstrap?.workspaceName}</button>

      {git?.isRepo && (
        <button onClick={() => patchUi({ sidePanel: 'git', sidebarWidth: 260 })} title="Source control">
          ⑂ {git.branch}
          {git.files.length > 0 ? ` ·${git.files.length}` : ''}
        </button>
      )}

      {current && <span>{current.path}</span>}
      {dirty > 0 && <span style={{ color: 'var(--accent)' }}>{dirty} unsaved</span>}

      <span className="sep" />

      {running && <span className="live">● working</span>}

      {changes.length > 0 && (
        <button
          style={{ color: 'var(--yellow)' }}
          onClick={() => patchUi({ mainView: 'review' })}
          title="Open the review screen"
        >
          {changes.length} to review
        </button>
      )}

      {mcp.length > 0 && (
        <button
          onClick={() => patchUi({ settingsOpen: true, settingsSection: 'mcp' })}
          style={{ color: mcpBroken > 0 ? 'var(--red)' : undefined }}
          title="MCP servers"
        >
          mcp {mcpReady}/{mcp.length}
        </button>
      )}

      {(totals.input > 0 || totals.output > 0) && (
        <span title="Tokens this session">
          ↑{compact(totals.input)} ↓{compact(totals.output)}
          {totals.costUsd > 0 && ` · $${totals.costUsd.toFixed(4)}`}
        </span>
      )}

      <button
        onClick={() => patchUi({ settingsOpen: true, settingsSection: 'permissions' })}
        style={
          settings.readOnly
            ? { color: 'var(--yellow)' }
            : settings.bypassPermissions
              ? { color: 'var(--red)' }
              : undefined
        }
      >
        {settings.readOnly
          ? 'read-only'
          : settings.bypassPermissions
            ? 'bypassing permissions'
            : `edits: ${settings.editApproval}`}
      </button>

      <button onClick={() => patchUi({ settingsOpen: true, settingsSection: 'providers' })}>
        {settings.activeModel}
      </button>

      <span
        title={
          bootstrap?.keysEncrypted
            ? 'API keys encrypted by the OS keychain'
            : 'API keys stored unencrypted'
        }
      >
        {bootstrap?.keysEncrypted ? '🔒' : '🔓'}
      </span>

      <button
        className="status-version"
        onClick={() => patchUi({ settingsOpen: true, settingsSection: 'about' })}
        title="Version — click to check for updates"
      >
        v{bootstrap?.appVersion ?? '—'}
      </button>
    </div>
  )
}

function compact(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1000) return `${(value / 1000).toFixed(1)}k`
  return String(value)
}
