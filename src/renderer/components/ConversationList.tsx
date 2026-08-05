import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ContentBlock, Message, SessionSummary } from '@shared/types'
import { useT } from '../i18n'
import { emptyView, useStore, type ChatEntry, type RenderBlock } from '../store'

/** A stored conversation plus whether it is mid-turn in the background. */
type SessionRow = SessionSummary & { running: boolean; open: boolean }

type Props = {
  /** The chat view gets a roomier treatment than the IDE sidebar tab. */
  variant: 'sidebar' | 'full'
}

export default function ConversationList({ variant }: Props) {
  const t = useT()
  const [sessions, setSessions] = useState<SessionRow[]>([])
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(true)

  const pushError = useStore((state) => state.pushError)
  const running = useStore((state) => state.running)
  const sessionId = useStore((state) => state.sessionId)
  const liveSessions = useStore((state) => state.liveSessions)

  const refresh = useCallback(async () => {
    try {
      setSessions(await window.forge.sessions.list())
    } catch (error) {
      pushError((error as Error).message)
    } finally {
      setLoading(false)
    }
  }, [pushError])

  useEffect(() => {
    void refresh()
  }, [refresh])

  // A finished turn is the moment history changes — in this conversation or in
  // one running behind it.
  useEffect(() => {
    if (!running) void refresh()
  }, [running, refresh])

  // The main process is the authority on what exists: a background turn
  // finishing, a task run being recorded, a workspace switch. Inferring it from
  // `running` alone missed all three.
  useEffect(() => window.forge.agent.onSessionsChanged(() => void refresh()), [refresh])

  useEffect(() => {
    void refresh()
  }, [liveSessions.length, refresh])

  const startNew = async (): Promise<void> => {
    await startNewConversation()
    void refresh()
  }

  /**
   * Switching no longer waits for the current turn. The conversation you leave
   * keeps running in the background and its output is waiting when you return.
   */
  const open = async (id: string): Promise<void> => {
    const store = useStore.getState()
    if (id === store.sessionId) return

    try {
      // A conversation already open in the main process has live state; one that
      // is not has to be read back from disk.
      const live = await window.forge.agent.state(id).catch(() => null)
      if (live) {
        await window.forge.agent.activate(id)
        store.switchSession(id, {
          ...emptyView(),
          entries: toEntries(live.messages),
          totals: live.totals,
          running: live.running,
          changes: live.changes
        })
        return
      }

      const record = await window.forge.sessions.load(id)
      store.switchSession(record.id, {
        ...emptyView(),
        entries: toEntries(record.messages),
        totals: record.totals
      })
    } catch (error) {
      pushError((error as Error).message)
    }
  }

  const groups = useMemo(() => groupByAge(sessions, query), [sessions, query])

  return (
    <>
      {/* The chat rail supplies its own header and New task button, so
          repeating them here would just be noise. */}
      {variant === 'sidebar' && (
        <div className="pane-header">
          {t('History')}
          <span style={{ flex: 1 }} />
          <button
            className="icon-btn"
            title={t('New conversation')}
            onClick={() => void startNew()}
          >
            {t('+ new')}
          </button>
        </div>
      )}

      <div className="convo-search">
        <input
          className="input"
          placeholder={t('Search conversations')}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>

      <div className="tree convo-list">
        {loading && <div className="empty-hint">{t('Loading…')}</div>}

        {!loading && sessions.length === 0 && (
          <div className="empty-hint">
            {t(
              'No saved conversations for this folder yet. They are stored per workspace and never inside your repository.'
            )}
          </div>
        )}

        {!loading && sessions.length > 0 && groups.every(([, items]) => items.length === 0) && (
          <div className="empty-hint">
            {t('Nothing matches')} “{query}”.
          </div>
        )}

        {groups.map(([label, items]) =>
          items.length === 0 ? null : (
            <div key={label}>
              <div className="git-group">{t(label)}</div>
              {items.map((session) => (
                <div
                  className={`session-row ${session.id === sessionId ? 'active' : ''}`}
                  key={session.id}
                >
                  <button className="session-open" onClick={() => void open(session.id)}>
                    <span className="session-title">
                      {session.running && <span className="session-live" aria-hidden />}
                      {session.title}
                    </span>
                    <span className="session-meta">
                      {session.running
                        ? t('working…')
                        : `${session.messageCount} ${t('msg')} · ${relative(session.updatedAt)}`}
                    </span>
                  </button>
                  <button
                    className="icon-btn danger"
                    title={t('Delete')}
                    onClick={async () => {
                      await window.forge.sessions.remove(session.id)
                      void refresh()
                    }}
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          )
        )}
      </div>
    </>
  )
}

/** Keeps the store's idea of the live session in step with the main process. */
export async function syncSessionId(): Promise<void> {
  const state = await window.forge.agent.state().catch(() => null)
  if (state) useStore.getState().setSessionId(state.id)
}

/**
 * Opens a fresh conversation. The one you were in is parked, not stopped: if it
 * was mid-turn it carries on, and its reply is there when you go back.
 */
export async function startNewConversation(): Promise<void> {
  const id = await window.forge.agent.create()
  useStore.getState().switchSession(id, emptyView())
}

const DAY = 86_400_000

function groupByAge<T extends SessionSummary>(sessions: T[], query: string): Array<[string, T[]]> {
  const needle = query.trim().toLowerCase()
  const matching = needle
    ? sessions.filter((session) => session.title.toLowerCase().includes(needle))
    : sessions

  const now = Date.now()
  const buckets: Array<[string, T[]]> = [
    ['Today', []],
    ['Yesterday', []],
    ['Previous 7 days', []],
    ['Older', []]
  ]

  for (const session of matching) {
    const age = now - session.updatedAt
    const index = age < DAY ? 0 : age < 2 * DAY ? 1 : age < 7 * DAY ? 2 : 3
    buckets[index][1].push(session)
  }

  return buckets
}

/** Rebuilds the renderer's view model from a stored transcript. */
export function toEntries(messages: Message[]): ChatEntry[] {
  const entries: ChatEntry[] = []
  const resultsByToolUse = new Map<string, ContentBlock>()

  for (const message of messages) {
    for (const block of message.content) {
      if (block.type === 'tool_result') resultsByToolUse.set(block.toolUseId, block)
    }
  }

  for (const message of messages) {
    // Tool-result turns are rendered inside the assistant message that asked
    // for them, so they never become entries of their own.
    const onlyToolResults =
      message.content.length > 0 && message.content.every((block) => block.type === 'tool_result')
    if (onlyToolResults) continue

    const blocks: RenderBlock[] = []
    for (const block of message.content) {
      if (block.type === 'text') blocks.push({ kind: 'text', text: block.text })
      else if (block.type === 'thinking') blocks.push({ kind: 'thinking', text: block.text })
      else if (block.type === 'tool_use') {
        const result = resultsByToolUse.get(block.id)
        blocks.push({
          kind: 'tool',
          use: block,
          result: result?.type === 'tool_result' ? result : undefined
        })
      }
    }

    if (blocks.length === 0) continue
    entries.push({
      id: message.id,
      role: message.role === 'assistant' ? 'assistant' : 'user',
      blocks,
      streaming: false
    })
  }

  return entries
}

function relative(timestamp: number): string {
  const seconds = Math.max(1, Math.round((Date.now() - timestamp) / 1000))
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.round(hours / 24)}d ago`
}
