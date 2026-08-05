import type { SessionRecord, SessionSummary } from '@shared/types'
import { AgentSession, type SessionDeps } from './session'

export interface LiveSession {
  id: string
  title: string
  running: boolean
  messageCount: number
}

export interface CreateOptions {
  /** False leaves the conversation open in the background, unfocused. */
  activate?: boolean
  /** Replaces or wraps the standard dependencies for this conversation only. */
  decorate?: (base: SessionDeps) => SessionDeps
}

/** Summary plus whether that conversation is mid-turn right now. */
export type SessionListEntry = SessionSummary & { running: boolean; open: boolean }

/**
 * Keeps every conversation alive at once.
 *
 * Switching chats used to mean loading history into the single session object,
 * which silently killed whatever the previous one was doing. Each conversation
 * now owns its own loop, abort signal and pending-change set, so leaving one to
 * work while you talk in another is the normal case rather than a hazard.
 */
export class SessionManager {
  private sessions = new Map<string, AgentSession>()
  private active = ''

  /**
   * `makeDeps` receives a getter rather than an id because a session's id
   * changes when a stored conversation is restored into it, and events must
   * carry the id it has at the time they fire.
   */
  constructor(
    private readonly makeDeps: (currentId: () => string) => SessionDeps,
    private readonly onListChanged: () => void
  ) {
    // spawn(), not create(): the first conversation is made while this instance
    // is still being constructed, so the caller's `onListChanged` cannot safely
    // reach back for it yet — the usual wiring closes over a `const manager`
    // that is still in its temporal dead zone. Nothing is listening this early
    // anyway, so there is nothing to announce.
    this.active = this.spawn().id
  }

  get activeId(): string {
    return this.active
  }

  get(id: string): AgentSession | undefined {
    return this.sessions.get(id)
  }

  /** The active session, creating one if the last was closed. */
  current(): AgentSession {
    const session = this.sessions.get(this.active)
    if (session) return session

    const fresh = this.create()
    this.active = fresh.id
    return fresh
  }

  /**
   * Opens a conversation.
   *
   * Both options exist for scheduled tasks, which run without anyone watching:
   * they need deps of their own (nobody is there to answer a permission
   * dialog) and they must not steal the view from whatever you are reading.
   */
  create(options: CreateOptions = {}): AgentSession {
    const session = this.spawn(options.decorate)
    if (options.activate !== false) this.active = session.id
    this.onListChanged()
    return session
  }

  /** Builds and registers a conversation without announcing it. */
  private spawn(decorate?: CreateOptions['decorate']): AgentSession {
    // Annotated because the deps closure refers to `session` before the
    // initialiser finishes, which TypeScript cannot infer through.
    const base = (): SessionDeps => this.makeDeps(() => session.id)
    const session: AgentSession = new AgentSession(decorate ? decorate(base()) : base())

    this.sessions.set(session.id, session)
    return session
  }

  activate(id: string): boolean {
    if (!this.sessions.has(id)) return false
    this.active = id
    return true
  }

  /** Opens a stored conversation, reusing its session if already loaded. */
  adopt(record: SessionRecord): AgentSession {
    const existing = this.sessions.get(record.id)
    if (existing) {
      this.active = existing.id
      return existing
    }

    const session = this.create()
    // restore() takes on the record's id, so the map key has to follow.
    this.sessions.delete(session.id)
    session.restore(record)
    this.sessions.set(session.id, session)
    this.active = session.id
    this.onListChanged()
    return session
  }

  close(id: string): void {
    const session = this.sessions.get(id)
    if (!session) return

    session.abort()
    this.sessions.delete(id)

    if (this.active === id) {
      this.active = [...this.sessions.keys()][0] ?? this.create().id
    }
    this.onListChanged()
  }

  list(): LiveSession[] {
    return [...this.sessions.values()].map((session) => ({
      id: session.id,
      title: session.title,
      running: session.isRunning,
      messageCount: session.messages.length
    }))
  }

  abortAll(): void {
    for (const session of this.sessions.values()) session.abort()
  }

  /**
   * Drops every conversation and starts one fresh.
   *
   * For a workspace change: conversations belong to the folder they were had
   * in, and keeping them would mix two projects in one list and hold their
   * transcripts in memory for the life of the process.
   */
  closeAll(): void {
    for (const session of this.sessions.values()) session.abort()
    this.sessions.clear()
    this.active = this.spawn().id
    this.onListChanged()
  }

  /**
   * Merges stored summaries with the live ones, so a conversation that is
   * running but has not been saved yet still appears in the list.
   */
  mergeSummaries(stored: SessionSummary[]): SessionListEntry[] {
    const live = new Map(this.list().map((entry) => [entry.id, entry]))
    const merged: SessionListEntry[] = []

    for (const summary of stored) {
      const match = live.get(summary.id)
      merged.push({ ...summary, running: match?.running ?? false, open: match !== undefined })
      live.delete(summary.id)
    }

    for (const entry of live.values()) {
      if (entry.messageCount === 0) continue
      merged.push({
        id: entry.id,
        title: entry.title,
        updatedAt: Date.now(),
        messageCount: entry.messageCount,
        running: entry.running,
        open: true
      })
    }

    return merged.sort((a, b) => b.updatedAt - a.updatedAt)
  }
}
