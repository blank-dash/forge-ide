import { useEffect, useRef } from 'react'
import { useStore } from '../store'
import ChatMessage from './ChatMessage'
import Composer from './Composer'
import { syncSessionId } from './ConversationList'

export default function ChatPanel() {
  const entries = useStore((state) => state.entries)
  const errors = useStore((state) => state.errors)
  const notices = useStore((state) => state.notices)
  const running = useStore((state) => state.running)
  const dismissError = useStore((state) => state.dismissError)
  const dismissNotice = useStore((state) => state.dismissNotice)
  const patchUi = useStore((state) => state.patchUi)

  const scroll = useRef<HTMLDivElement>(null)
  const pinned = useRef(true)

  // Follow the stream, but stop fighting the user once they scroll up.
  useEffect(() => {
    const element = scroll.current
    if (!element || !pinned.current) return
    element.scrollTop = element.scrollHeight
  }, [entries, errors, notices, running])

  const onScroll = (): void => {
    const element = scroll.current
    if (!element) return
    const distance = element.scrollHeight - element.scrollTop - element.clientHeight
    pinned.current = distance < 60
  }

  return (
    <>
      <div className="pane-header">
        Agent
        <span style={{ flex: 1 }} />
        <button
          className="icon-btn"
          title="Saved conversations"
          onClick={() => patchUi({ sidePanel: 'sessions', sidebarWidth: 260 })}
        >
          history
        </button>
        <button
          className="icon-btn"
          title="New conversation"
          onClick={async () => {
            await window.forge.agent.reset()
            useStore.getState().clearChat()
            await syncSessionId()
          }}
        >
          + new
        </button>
      </div>

      <div className="chat-scroll" ref={scroll} onScroll={onScroll}>
        {entries.length === 0 && errors.length === 0 && <EmptyState />}

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
            <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
              <span style={{ flex: 1 }}>{error.message}</span>
              <button className="icon-btn" onClick={() => dismissError(error.id)}>
                ×
              </button>
            </div>
            {error.detail && <div className="detail">{error.detail}</div>}
            {/api key|unauthor|401|403/i.test(error.message) && (
              <button
                className="btn"
                style={{ marginTop: 8 }}
                onClick={() => patchUi({ settingsOpen: true, settingsSection: 'providers' })}
              >
                Open provider settings
              </button>
            )}
          </div>
        ))}
      </div>

      <Composer />
    </>
  )
}

function EmptyState() {
  const patchUi = useStore((state) => state.patchUi)
  const providers = useStore((state) => state.settings.providers)
  const mode = useStore((state) => state.settings.mode)
  const configured = providers.some((provider) => provider.enabled && provider.apiKey)

  if (!configured) {
    return (
      <div className="empty-hint" style={{ lineHeight: 1.75 }}>
        <strong style={{ color: 'var(--fg-1)' }}>No model connected yet.</strong>
        <br />
        Add an API key for any provider — Anthropic, OpenAI, Gemini, OpenRouter, a local
        Ollama/LM Studio server, or any custom OpenAI-compatible endpoint.
        <br />
        <br />
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
    <div className="empty-hint" style={{ lineHeight: 1.75 }}>
      {mode === 'chat' ? (
        <>
          <strong style={{ color: 'var(--fg-1)' }}>Chat mode.</strong> The agent can read and
          search but not change anything. Switch to <strong>Edit</strong> below when you want it to
          work.
        </>
      ) : (
        <>
          <strong style={{ color: 'var(--fg-1)' }}>Edit mode.</strong> Describe a change and the
          agent will make it. Changes land in the review screen so you can keep or revert each file.
        </>
      )}
      <br />
      <br />
      Type <code>/</code> for commands, <code>@</code> to reference a file. Paste an absolute path
      and the agent can work on files anywhere on this machine — you approve each new location.
    </div>
  )
}
