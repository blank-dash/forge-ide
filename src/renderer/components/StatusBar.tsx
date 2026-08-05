import { useStore } from '../store'
import ProfileMenu from './ProfileMenu'
import { LiveIndicator } from './LivePane'
import Spinner from './Spinner'

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
  const sessionId = useStore((state) => state.sessionId)
  const liveSessions = useStore((state) => state.liveSessions)

  // Conversations mid-turn other than the one on screen.
  const backgroundRunning = liveSessions.filter((id) => id !== sessionId).length

  const current = tabs.find((tab) => tab.path === activeTab)
  const dirty = tabs.filter((tab) => tab.content !== tab.savedContent).length
  const mcpReady = mcp.filter((server) => server.state === 'ready').length
  const mcpBroken = mcp.filter((server) => server.state === 'error').length

  return (
    <div className="statusbar">
      <ProfileMenu />

      <button
        className="status-settings"
        onClick={() => patchUi({ settingsOpen: true })}
        title="Settings (Ctrl+,)"
      >
        ⚙
      </button>

      <button onClick={() => patchUi({ sidePanel: 'explorer' })}>{bootstrap?.workspaceName}</button>

      {git?.isRepo && (
        <button
          onClick={() => patchUi({ sidePanel: 'git', sidebarWidth: 260 })}
          title="Source control"
        >
          ⑂ {git.branch}
          {git.files.length > 0 ? ` ·${git.files.length}` : ''}
        </button>
      )}

      {current && (
        <span className="status-path" title={current.path}>
          {baseName(current.path)}
        </span>
      )}
      {dirty > 0 && <span style={{ color: 'var(--accent)' }}>{dirty} unsaved</span>}

      <span className="sep" />

      <LiveIndicator />

      {running && (
        <span className="live">
          <Spinner /> working
        </span>
      )}

      {backgroundRunning > 0 && (
        <button
          className="live"
          onClick={() => patchUi({ sidePanel: 'sessions', sidebarWidth: 260 })}
          title="Conversations working in the background"
        >
          +{backgroundRunning} in background
        </button>
      )}

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

/** The file name alone; the full path is on the tooltip. */
function baseName(path: string): string {
  const parts = path.split(/[\/]/)
  return parts[parts.length - 1] || path
}

function compact(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1000) return `${(value / 1000).toFixed(1)}k`
  return String(value)
}
