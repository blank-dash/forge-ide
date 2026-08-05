import { useEffect, useRef } from 'react'
import { useStore } from '../store'
import ChatMessage from './ChatMessage'
import ChatNav from './ChatNav'
import Composer from './Composer'
import Dashboard from './Dashboard'
import BrowserPane from './BrowserPane'
import LivePane from './LivePane'
import ScheduledTasks from './ScheduledTasks'
import ErrorBoundary from './ErrorBoundary'
import Resizer from './Resizer'

const PANE_LABELS: Record<string, string> = {
  tasks: 'Scheduled tasks',
  live: 'Live mode',
  dashboard: 'The dashboard'
}

/**
 * Chat mode: the whole window is the conversation, with history down the left.
 * Edit mode keeps the IDE layout — this view is for when you are thinking about
 * the code rather than changing it.
 */
export default function ChatView() {
  const entries = useStore((state) => state.entries)
  const errors = useStore((state) => state.errors)
  const notices = useStore((state) => state.notices)
  const running = useStore((state) => state.running)
  const chatSidebarWidth = useStore((state) => state.ui.chatSidebarWidth)
  const chatPane = useStore((state) => state.ui.chatPane)
  const patchUi = useStore((state) => state.patchUi)
  const dismissError = useStore((state) => state.dismissError)
  const dismissNotice = useStore((state) => state.dismissNotice)

  const scroll = useRef<HTMLDivElement>(null)
  const pinned = useRef(true)

  useEffect(() => {
    const element = scroll.current
    if (!element || !pinned.current) return
    element.scrollTop = element.scrollHeight
  }, [entries, errors, notices, running])

  const onScroll = (): void => {
    const element = scroll.current
    if (!element) return
    pinned.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80
  }

  return (
    <div className="body">
      {chatSidebarWidth > 0 && (
        <>
          <div className="pane sidebar" style={{ width: chatSidebarWidth }}>
            <ErrorBoundary label="The sidebar">
              <ChatNav />
            </ErrorBoundary>
          </div>
          <Resizer
            axis="x"
            onDelta={(delta) =>
              patchUi({
                chatSidebarWidth: clamp(useStore.getState().ui.chatSidebarWidth + delta, 180, 480)
              })
            }
          />
        </>
      )}

      <div className="pane chat-full">
        {chatPane === 'browser' ? (
          <ErrorBoundary label="The browser">
            {/* Full-bleed: the page is a native view, and boxing it in the
                reading column would leave most of the window empty. */}
            <BrowserPane />
          </ErrorBoundary>
        ) : chatPane !== 'chats' ? (
          <ErrorBoundary label={PANE_LABELS[chatPane] ?? 'This pane'}>
            <div className="chat-full-scroll">
              <div className="chat-column">
                {chatPane === 'tasks' && <ScheduledTasks />}
                {chatPane === 'live' && <LivePane />}
                {chatPane === 'dashboard' && <Dashboard />}
              </div>
            </div>
          </ErrorBoundary>
        ) : (
          <ErrorBoundary label="The conversation">
            <div className="chat-full-scroll" ref={scroll} onScroll={onScroll}>
              <div className="chat-column">
                {entries.length === 0 && errors.length === 0 && <ChatWelcome />}

                {entries.map((entry) => (
                  <ChatMessage key={entry.id} entry={entry} />
                ))}

                {notices.map((notice) => (
                  <div className="notice-block" key={notice.id}>
                    <span style={{ flex: 1 }}>{notice.message}</span>
                    <button className="icon-btn" onClick={() => dismissNotice(notice.id)}>
                      ×
                    </button>
                  </div>
                ))}

                {errors.map((error) => (
                  <div className="error-block" key={error.id}>
                    <div
                      style={{
                        display: 'flex',
                        gap: 8,
                        alignItems: 'flex-start'
                      }}
                    >
                      <span style={{ flex: 1 }}>{error.message}</span>
                      <button className="icon-btn" onClick={() => dismissError(error.id)}>
                        ×
                      </button>
                    </div>
                    {error.detail && <div className="detail">{error.detail}</div>}
                  </div>
                ))}
              </div>
            </div>

            <div className="chat-full-composer">
              <div className="chat-column">
                <Composer />
              </div>
            </div>
          </ErrorBoundary>
        )}
      </div>
    </div>
  )
}

function ChatWelcome() {
  const providers = useStore((state) => state.settings.providers)
  const workspaceName = useStore((state) => state.bootstrap?.workspaceName)
  const patchUi = useStore((state) => state.patchUi)
  const saveSettings = useStore((state) => state.saveSettings)
  const configured = providers.some((provider) => provider.enabled && provider.apiKey)

  if (!configured) {
    return (
      <div className="chat-welcome">
        <h1>Connect a model to begin</h1>
        <p>
          Anthropic, OpenAI, Gemini, OpenRouter, a local Ollama or LM Studio server, or any
          OpenAI-compatible endpoint you have a key for.
        </p>
        <button
          className="btn btn-primary"
          onClick={() => patchUi({ settingsOpen: true, settingsSection: 'providers' })}
        >
          Connect a model
        </button>
      </div>
    )
  }

  return (
    <div className="chat-welcome">
      <h1>What are we working on?</h1>
      <p>
        Ask about <strong>{workspaceName}</strong>. The agent has every tool here that it has in
        Edit view — reading, searching, editing, running commands. This view just gives the
        conversation the whole window.
      </p>
      <p className="chat-welcome-hint">
        Type <code>/</code> for commands, <code>@</code> to reference a file, paste a screenshot or
        an absolute path to point at anything on this machine.
      </p>
      <button className="btn" onClick={() => void saveSettings({ mode: 'agent' })}>
        Open the editor instead
      </button>
    </div>
  )
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}
