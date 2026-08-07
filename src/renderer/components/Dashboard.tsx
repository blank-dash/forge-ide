import { useEffect, useState } from 'react'
import type { SessionSummary } from '@shared/types'
import { useT } from '../i18n'
import { emptyView, useStore } from '../store'
import { toEntries } from './ConversationList'
import Spinner from './Spinner'

type Row = SessionSummary & { running: boolean; open: boolean }

/**
 * A read-only overview of the workspace.
 *
 * Everything here is state the app already holds and would otherwise only be
 * legible one status-bar chip at a time: what is running, what is waiting on
 * you, what this has cost, and what the repository looks like underneath.
 */
export default function Dashboard() {
  const t = useT()
  const bootstrap = useStore((state) => state.bootstrap)
  const settings = useStore((state) => state.settings)
  const totals = useStore((state) => state.totals)
  const context = useStore((state) => state.context)
  const changes = useStore((state) => state.changes)
  const git = useStore((state) => state.git)
  const mcp = useStore((state) => state.mcp)
  const liveSessions = useStore((state) => state.liveSessions)
  const patchUi = useStore((state) => state.patchUi)
  const saveSettings = useStore((state) => state.saveSettings)

  const [sessions, setSessions] = useState<Row[]>([])
  const [tasks, setTasks] = useState<Array<{ enabled: boolean; nextRunAt: number | null }>>([])
  const [history, setHistory] = useState<
    Array<{ date: string; costUsd: number; input: number; output: number; turns: number }>
  >([])

  useEffect(() => {
    void window.forge.sessions
      .list()
      .then(setSessions)
      .catch(() => setSessions([]))
    void window.forge.tasks
      .list()
      .then(setTasks)
      .catch(() => setTasks([]))
    void window.forge.usage
      .history()
      .then(setHistory)
      .catch(() => setHistory([]))
    // Re-read whenever something finishes, so the counts are not stale.
  }, [liveSessions.length, changes.length])

  const mcpReady = mcp.filter((server) => server.state === 'ready').length
  const contextPercent = context ? Math.round((context.used / context.window) * 100) : null
  const messageCount = sessions.reduce((sum, session) => sum + session.messageCount, 0)

  const open = async (id: string): Promise<void> => {
    patchUi({ chatPane: 'chats' })
    const live = await window.forge.agent.state(id).catch((error) => {
      console.warn('[dashboard] live session unavailable', id, error)
      return null
    })
    const store = useStore.getState()

    if (live) {
      await window.forge.agent.activate(id)
      store.switchSession(id, {
        ...emptyView(),
        entries: toEntries(live.messages),
        totals: live.totals,
        running: live.running,
        changes: live.changes
      })
      store.setSessionModel(live.model ?? null)
      return
    }

    const record = await window.forge.sessions.load(id).catch((error) => {
      useStore.getState().pushError(`Could not load session: ${(error as Error).message}`)
      return null
    })
    if (record) {
      store.switchSession(record.id, {
        ...emptyView(),
        entries: toEntries(record.messages),
        totals: record.totals
      })
      store.setSessionModel(record.model ?? null)
    }
  }

  return (
    <div className="dashboard">
      <header className="dashboard-head">
        <h1>{bootstrap?.workspaceName ?? t('Dashboard')}</h1>
        <p className="dashboard-path">{bootstrap?.cwd}</p>
      </header>

      <div className="dashboard-grid">
        <Card
          label={t('Working now')}
          value={
            liveSessions.length > 0 ? (
              <span className="dash-live">
                <Spinner /> {liveSessions.length}
              </span>
            ) : (
              '0'
            )
          }
          hint={
            liveSessions.length > 0
              ? t('Conversations mid-turn, including ones you have left')
              : t('Nothing running')
          }
        />

        <Card
          label={t('Waiting for review')}
          value={String(changes.length)}
          hint={changes.length > 0 ? t('Edits staged, not yet applied') : t('No pending edits')}
          tone={changes.length > 0 ? 'warn' : undefined}
          onClick={changes.length > 0 ? () => void saveSettings({ mode: 'agent' }) : undefined}
        />

        <Card
          label={t('Spent this conversation')}
          value={totals.costUsd > 0 ? `$${totals.costUsd.toFixed(4)}` : '—'}
          hint={`↑${compact(totals.input)} ↓${compact(totals.output)}${
            totals.cacheRead > 0 ? ` · ${compact(totals.cacheRead)} ${t('cached')}` : ''
          }`}
        />

        <Card
          label={t('Context used')}
          value={contextPercent === null ? '—' : `${contextPercent}%`}
          hint={
            context
              ? `${compact(context.used)} / ${compact(context.window)}${
                  context.estimated ? ` · ${t('estimated')}` : ''
                }`
              : t('Nothing sent yet')
          }
          tone={contextPercent !== null && contextPercent > 80 ? 'warn' : undefined}
        />

        <Card
          label={t('Model')}
          value={settings.activeModel.split(':').slice(1).join(':') || settings.activeModel}
          hint={settings.activeModel.split(':')[0]}
          onClick={() => patchUi({ settingsOpen: true, settingsSection: 'providers' })}
        />

        <Card
          label={t('Repository')}
          value={git?.isRepo ? git.branch : t('Not a repo')}
          hint={
            git?.isRepo
              ? git.files.length > 0
                ? `${git.files.length} ${t('changed files')}`
                : t('Clean')
              : t('Version control is off for this folder')
          }
        />

        <Card
          label={t('MCP servers')}
          value={mcp.length === 0 ? '—' : `${mcpReady}/${mcp.length}`}
          hint={mcp.length === 0 ? t('None configured') : t('Connected and answering')}
          tone={mcp.some((server) => server.state === 'error') ? 'bad' : undefined}
          onClick={() => patchUi({ settingsOpen: true, settingsSection: 'mcp' })}
        />

        <Card
          label={t('Scheduled tasks')}
          value={String(tasks.filter((task) => task.enabled).length)}
          hint={nextTaskHint(tasks, t)}
          onClick={() => patchUi({ chatPane: 'tasks' })}
        />

        <Card
          label={t('Saved conversations')}
          value={String(sessions.length)}
          hint={`${messageCount} ${t('messages in total')}`}
          onClick={() => patchUi({ chatPane: 'chats' })}
        />
      </div>

      {history.length > 0 && (
        <>
          <h2 className="dashboard-subhead">{t('Spending')}</h2>
          <SpendChart days={history} />
        </>
      )}

      <h2 className="dashboard-subhead">{t('Recent')}</h2>

      {sessions.length === 0 ? (
        <div className="empty-hint">{t('No conversations in this folder yet.')}</div>
      ) : (
        <div className="dashboard-recent">
          {sessions.slice(0, 8).map((session) => (
            <button key={session.id} className="dash-row" onClick={() => void open(session.id)}>
              <span className="dash-row-title">
                {session.running && <span className="session-live" aria-hidden />}
                {session.title}
              </span>
              <span className="dash-row-meta">
                {session.running ? t('working…') : `${session.messageCount} msg`}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

type CardProps = {
  label: string
  value: React.ReactNode
  hint?: string
  tone?: 'warn' | 'bad'
  onClick?: () => void
}

function Card({ label, value, hint, tone, onClick }: CardProps) {
  const className = `dash-card ${tone ? `tone-${tone}` : ''} ${onClick ? 'clickable' : ''}`
  const body = (
    <>
      <span className="dash-card-label">{label}</span>
      <span className="dash-card-value">{value}</span>
      {hint && <span className="dash-card-hint">{hint}</span>}
    </>
  )

  return onClick ? (
    <button className={className} onClick={onClick}>
      {body}
    </button>
  ) : (
    <div className={className}>{body}</div>
  )
}

/** When the soonest enabled task is due, or why none is. */
function nextTaskHint(
  tasks: Array<{ enabled: boolean; nextRunAt: number | null }>,
  t: (text: string) => string
): string {
  const due = tasks
    .filter((task) => task.enabled && task.nextRunAt !== null)
    .map((task) => task.nextRunAt as number)

  if (due.length === 0) return tasks.length === 0 ? t('None set up') : t('None scheduled')

  const minutes = Math.max(0, Math.round((Math.min(...due) - Date.now()) / 60_000))
  if (minutes < 60) return `${t('next in')} ${minutes} ${t('min')}`

  const hours = Math.round(minutes / 60)
  return hours < 24 ? `${t('next in')} ${hours} ${t('h')}` : t('next tomorrow')
}

/**
 * Two weeks of spending, as bars.
 *
 * No axis and no legend: the question this answers is "is today unlike the
 * other days", which a shape answers faster than numbers would.
 */
function SpendChart({ days }: { days: Array<{ date: string; costUsd: number; turns: number }> }) {
  const recent = days.slice(0, 14).reverse()
  const peak = Math.max(...recent.map((day) => day.costUsd), 0.0001)
  const total = recent.reduce((sum, day) => sum + day.costUsd, 0)

  return (
    <div className="spend">
      <div className="spend-bars">
        {recent.map((day) => (
          <div
            className="spend-col"
            key={day.date}
            title={`${day.date} · $${day.costUsd.toFixed(4)} · ${day.turns} turns`}
          >
            <div
              className="spend-bar"
              style={{ height: `${Math.max(2, (day.costUsd / peak) * 100)}%` }}
            />
            <span className="spend-day">{day.date.slice(8)}</span>
          </div>
        ))}
      </div>
      <div className="spend-total">
        ${total.toFixed(2)} over {recent.length} days
      </div>
    </div>
  )
}

function compact(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1000) return `${(value / 1000).toFixed(1)}k`
  return String(value)
}
