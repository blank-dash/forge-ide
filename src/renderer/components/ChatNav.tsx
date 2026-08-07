import { useT } from '../i18n'
import { useStore } from '../store'
import ConversationList, { startNewConversation } from './ConversationList'
import ErrorBoundary from './ErrorBoundary'
import Spinner from './Spinner'

/**
 * The rail down the left of chat mode.
 *
 * Three bands, in the order you reach for them: which layout you are in, the
 * one action that starts work, then everything you might want to look at —
 * with the conversation list taking whatever height is left, because that is
 * what you actually scroll.
 */
export default function ChatNav() {
  const t = useT()
  const mode = useStore((state) => state.settings.mode)
  const saveSettings = useStore((state) => state.saveSettings)
  const chatPane = useStore((state) => state.ui.chatPane)
  const patchUi = useStore((state) => state.patchUi)
  const changes = useStore((state) => state.changes.length)
  const mcp = useStore((state) => state.mcp)
  const liveSessions = useStore((state) => state.liveSessions)
  const runningTasks = useStore((state) => state.runningTasks.length)
  const live = useStore((state) => state.live)
  const sessionId = useStore((state) => state.sessionId)

  const mcpBroken = mcp.filter((server) => server.state === 'error').length

  return (
    <div className="chat-nav">
      <div className="mode-switch chat-nav-modes" role="tablist" aria-label={t('Layout')}>
        <button
          role="tab"
          aria-selected={mode === 'agent'}
          className={mode === 'agent' ? 'active' : ''}
          onClick={() => void saveSettings({ mode: 'agent' })}
          title={t('Editor, file tree and terminal alongside the agent')}
        >
          {t('Work')}
        </button>
        <button
          role="tab"
          aria-selected={mode === 'chat'}
          className={mode === 'chat' ? 'active' : ''}
          onClick={() => void saveSettings({ mode: 'chat' })}
          title={t('The whole window for the conversation. Same tools either way.')}
        >
          {t('Chat')}
        </button>
      </div>

      <button
        className="chat-nav-new"
        onClick={() => {
          patchUi({ chatPane: 'chats' })
          void startNewConversation()
        }}
      >
        <span className="chat-nav-plus">+</span>
        {t('New task')}
        {liveSessions.length > 0 && (
          <span className="chat-nav-badge" title={t('Conversations working right now')}>
            <Spinner />
            {liveSessions.length}
          </span>
        )}
      </button>

      <nav className="chat-nav-links">
        <NavRow
          icon="▦"
          label={t('Dashboard')}
          active={chatPane === 'dashboard'}
          onClick={() => patchUi({ chatPane: 'dashboard' })}
        />
        <NavRow
          icon="◫"
          label={t('Chats')}
          active={chatPane === 'chats'}
          onClick={() => patchUi({ chatPane: 'chats' })}
        />
        <NavRow
          icon="◷"
          label={t('Scheduled tasks')}
          active={chatPane === 'tasks'}
          badge={runningTasks > 0 ? String(runningTasks) : undefined}
          onClick={() => patchUi({ chatPane: 'tasks' })}
        />
        <NavRow
          icon="◉"
          label={t('Live mode')}
          active={chatPane === 'live'}
          badge={live?.active ? '●' : undefined}
          onClick={() => {
            patchUi({ chatPane: 'live' })
            if (!live?.active && sessionId)
              setTimeout(
                () =>
                  window.dispatchEvent(new CustomEvent('forge:live-start', { detail: sessionId })),
                0
              )
          }}
        />
        <NavRow
          icon="◍"
          label={t('Browser')}
          active={chatPane === 'browser'}
          onClick={() => patchUi({ chatPane: 'browser' })}
        />
        <NavRow
          icon="⌥"
          label={t('Review')}
          badge={changes > 0 ? String(changes) : undefined}
          onClick={() => void saveSettings({ mode: 'agent' })}
        />
        <NavRow
          icon="🧩"
          label={t('Plugins')}
          badge={mcpBroken > 0 ? '!' : undefined}
          onClick={() => patchUi({ settingsOpen: true, settingsSection: 'mcp' })}
        />
      </nav>

      {chatPane === 'chats' && (
        <div className="chat-nav-list">
          <ErrorBoundary label="Conversation history">
            <ConversationList variant="full" />
          </ErrorBoundary>
        </div>
      )}
    </div>
  )
}

type RowProps = {
  icon: string
  label: string
  active?: boolean
  badge?: string
  onClick: () => void
}

function NavRow({ icon, label, active, badge, onClick }: RowProps) {
  return (
    <button className={`chat-nav-row ${active ? 'active' : ''}`} onClick={onClick}>
      <span className="chat-nav-icon">{icon}</span>
      <span className="chat-nav-label">{label}</span>
      {badge && <span className="chat-nav-count">{badge}</span>}
    </button>
  )
}
