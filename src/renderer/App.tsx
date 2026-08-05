import { useCallback, useEffect } from 'react'
import ChatPanel from './components/ChatPanel'
import ChatView from './components/ChatView'
import ConversationList, { startNewConversation } from './components/ConversationList'
import { CommandPalette, OutlinePicker, QuickOpen } from './components/Pickers'
import SearchPanel from './components/SearchPanel'
import EditorPane from './components/EditorPane'
import ErrorBoundary from './components/ErrorBoundary'
import FileTree from './components/FileTree'
import GitPanel from './components/GitPanel'
import PermissionDialog from './components/PermissionDialog'
import Resizer from './components/Resizer'
import ReviewPanel from './components/ReviewPanel'
import SettingsModal from './components/SettingsModal'
import SetupWizard from './components/SetupWizard'
import StatusBar from './components/StatusBar'
import TerminalPane from './components/TerminalPane'
import TitleBar from './components/TitleBar'
import TaskToast from './components/TaskToast'
import UpdateToast from './components/UpdateToast'
import { useStore, type SidePanel } from './store'

const SIDE_PANELS: Array<{ id: SidePanel; label: string; hint: string }> = [
  { id: 'explorer', label: 'Files', hint: 'Explorer' },
  { id: 'git', label: 'Git', hint: 'Source control' },
  { id: 'sessions', label: 'History', hint: 'Saved conversations' },
  { id: 'search', label: 'Search', hint: 'Search across files (Ctrl+Shift+F)' }
]

/** Whichever overlay picker is open. Mounted in both layouts. */
function Pickers(): JSX.Element | null {
  const picker = useStore((state) => state.ui.picker)
  const patchUi = useStore((state) => state.patchUi)
  const close = (): void => patchUi({ picker: 'none' })

  if (picker === 'files') return <QuickOpen onClose={close} />
  if (picker === 'commands') return <CommandPalette onClose={close} />
  if (picker === 'symbols') return <OutlinePicker onClose={close} />
  return null
}

export default function App() {
  const ready = useStore((state) => state.ready)
  const ui = useStore((state) => state.ui)
  const settings = useStore((state) => state.settings)
  const patchUi = useStore((state) => state.patchUi)

  /* ---------------- bootstrap & subscriptions ---------------- */

  useEffect(() => {
    const store = useStore.getState()

    void window.forge
      .bootstrap()
      .then(async (bootstrap) => {
        store.init(bootstrap)
        // Restore whatever the main process already had (survives a reload).
        const state = await window.forge.agent.state().catch(() => null)
        if (state) {
          store.setChanges(state.changes ?? [])
          store.setSessionId(state.id)
          store.setSessionModel(state.model ?? null)
        }
        // A task can already be mid-run when the window opens — after a reload,
        // or because the app was launched into one that was overdue.
        for (const task of await window.forge.tasks.list().catch(() => [])) {
          if (task.running) store.setTaskRunning(task.id, true)
        }
        // A live session survives a renderer reload, so the indicator has to
        // come back with it rather than waiting for the next status event.
        store.setLive(await window.forge.live.status().catch(() => null))
        store.setMcp(await window.forge.mcp.status().catch(() => []))
        store.setGit(await window.forge.git.status().catch(() => null))
      })
      .catch((error: Error) => store.pushError(`Startup failed: ${error.message}`))

    const unsubscribes = [
      window.forge.agent.onEvent(({ sessionId, event }) =>
        useStore.getState().applyEvent(event, sessionId),
      ),
      window.forge.agent.onSessionsChanged((sessions) =>
        useStore.getState().setLiveSessions(sessions),
      ),
      // The agent opening a page is only useful if it is also shown.
      window.forge.live.onStatus((status) => useStore.getState().setLive(status)),
      window.forge.browser.onReveal(() => {
        const state = useStore.getState()
        if (state.settings.mode !== 'chat') void state.saveSettings({ mode: 'chat' })
        state.patchUi({ chatPane: 'browser' })
      }),
      window.forge.agent.onPermissionRequest((request) =>
        useStore.getState().setPermission(request),
      ),
      window.forge.agent.onPermissionCancelled((id) => {
        const current = useStore.getState().permission
        if (current?.id === id) useStore.getState().setPermission(null)
      }),
      window.forge.settings.onChanged((next) => useStore.getState().setSettings(next)),
      window.forge.mcp.onStatus((statuses) => useStore.getState().setMcp(statuses)),
    ]

    return () => {
      for (const off of unsubscribes) off()
    }
  }, [])

  /* ---------------- theme ---------------- */

  useEffect(() => {
    const root = document.documentElement
    root.dataset.theme = settings.theme
    root.style.setProperty('--accent', settings.accent)
    root.style.setProperty('--chat-size', `${settings.chatFontSize}px`)
    root.style.setProperty('--editor-size', `${settings.editorFontSize}px`)
    root.style.setProperty('--mono', settings.fontFamily)
    window.forge.setZoom(settings.uiScale)
  }, [
    settings.theme,
    settings.accent,
    settings.chatFontSize,
    settings.editorFontSize,
    settings.fontFamily,
    settings.uiScale,
  ])

  /* ---------------- application menu ---------------- */

  const runCommand = useCallback(
    async (command: string, payload?: unknown) => {
      const state = useStore.getState()

      switch (command) {
        case 'menu:open-folder': {
          const picked = await window.forge.workspace.pick()
          if (picked) window.location.reload()
          break
        }
        case 'menu:new-session':
          await startNewConversation()
          break
        case 'menu:save':
          state.requestSave()
          break
        case 'menu:settings':
          patchUi({ settingsOpen: true })
          break
        case 'menu:mode':
          await state.saveSettings({ mode: payload === 'chat' ? 'chat' : 'agent' })
          break
        case 'menu:toggle-sidebar':
          patchUi({ sidebarWidth: state.ui.sidebarWidth > 0 ? 0 : 240 })
          break
        case 'menu:toggle-terminal':
          if (state.settings.mode === 'agent') patchUi({ terminalOpen: !state.ui.terminalOpen })
          break
        case 'menu:review':
          patchUi({ mainView: state.ui.mainView === 'review' ? 'editor' : 'review' })
          break
        case 'menu:git':
          patchUi({ sidePanel: 'git', sidebarWidth: Math.max(state.ui.sidebarWidth, 240) })
          break
        case 'menu:picker':
          patchUi({ picker: payload as 'files' | 'commands' | 'symbols' })
          break
        case 'menu:search':
          await state.saveSettings({ mode: 'agent' })
          patchUi({ sidePanel: 'search', sidebarWidth: Math.max(state.ui.sidebarWidth, 320) })
          break
        case 'menu:check-updates':
          patchUi({ settingsOpen: true, settingsSection: 'about' })
          await window.forge.updates.check().catch(() => undefined)
          break
      }
    },
    [patchUi],
  )

  /*
   * The pickers are keyed here rather than in the application menu.
   *
   * A menu accelerator fires even while a text box has focus, which for Ctrl+P
   * and Ctrl+F is wrong — those belong to the field you are typing in. Handling
   * them in the document lets an input opt out; the menu keeps the shortcuts
   * that are unambiguous everywhere.
   */
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const mod = event.ctrlKey || event.metaKey
      if (!mod) return

      const key = event.key.toLowerCase()
      const state = useStore.getState()

      if (event.shiftKey && key === 'p') {
        event.preventDefault()
        state.patchUi({ picker: 'commands' })
      } else if (event.shiftKey && key === 'o') {
        event.preventDefault()
        state.patchUi({ picker: 'symbols' })
      } else if (event.shiftKey && key === 'f') {
        event.preventDefault()
        void state.saveSettings({ mode: 'agent' })
        state.patchUi({ sidePanel: 'search', sidebarWidth: Math.max(state.ui.sidebarWidth, 320) })
      } else if (!event.shiftKey && key === 'p') {
        event.preventDefault()
        state.patchUi({ picker: 'files' })
      }
    }

    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  useEffect(() => {
    // Every other shortcut lives in the application menu; handling the same
    // keys here as well would toggle things twice.
    const offMenu = window.forge.menu.on((command, payload) => void runCommand(command, payload))
    const offWorkspace = window.forge.menu.onWorkspaceChanged(() => window.location.reload())
    return () => {
      offMenu()
      offWorkspace()
    }
  }, [runCommand])

  if (!ready) {
    return (
      <div className="app">
        <TitleBar />
        <div className="welcome">
          <h2>Starting Forge…</h2>
        </div>
      </div>
    )
  }

  if (settings.mode === 'chat') {
    return (
      <div className="app">
        <TitleBar />
        <ChatView />
        <StatusBar />
        <PermissionDialog />
        <UpdateToast />
        <TaskToast />
      <Pickers />
        <Pickers />
        {ui.settingsOpen && (
          <ErrorBoundary label="Settings">
            <SettingsModal />
          </ErrorBoundary>
        )}
        {!settings.setupCompleted && <SetupWizard />}
      </div>
    )
  }

  return (
    <div className="app">
      <TitleBar />

      <div className="body">
        {ui.sidebarWidth > 0 && (
          <>
            <div className="pane sidebar" style={{ width: ui.sidebarWidth }}>
              <div className="side-tabs" role="tablist">
                {SIDE_PANELS.map((panel) => (
                  <button
                    key={panel.id}
                    role="tab"
                    aria-selected={ui.sidePanel === panel.id}
                    className={ui.sidePanel === panel.id ? 'active' : ''}
                    title={panel.hint}
                    onClick={() => patchUi({ sidePanel: panel.id })}
                  >
                    {panel.label}
                  </button>
                ))}
              </div>

              <ErrorBoundary label="The sidebar">
                {ui.sidePanel === 'explorer' && <FileTree />}
                {ui.sidePanel === 'git' && <GitPanel />}
                {ui.sidePanel === 'sessions' && <ConversationList variant="sidebar" />}
                {ui.sidePanel === 'search' && <SearchPanel />}
              </ErrorBoundary>
            </div>
            <Resizer
              axis="x"
              onDelta={(delta) =>
                patchUi({
                  sidebarWidth: clamp(useStore.getState().ui.sidebarWidth + delta, 170, 560),
                })
              }
            />
          </>
        )}

        <div className="pane" style={{ flex: 1 }}>
          <ErrorBoundary label="The editor">
            {ui.mainView === 'review' ? <ReviewPanel /> : <EditorPane />}
          </ErrorBoundary>

          {ui.terminalOpen && (
            <>
              <Resizer
                axis="y"
                onDelta={(delta) =>
                  patchUi({
                    terminalHeight: clamp(
                      useStore.getState().ui.terminalHeight - delta,
                      100,
                      window.innerHeight - 260,
                    ),
                  })
                }
              />
              <div className="pane terminal-pane" style={{ height: ui.terminalHeight }}>
                <ErrorBoundary label="The terminal">
                  <TerminalPane />
                </ErrorBoundary>
              </div>
            </>
          )}
        </div>

        <Resizer
          axis="x"
          onDelta={(delta) =>
            patchUi({ chatWidth: clamp(useStore.getState().ui.chatWidth - delta, 340, 900) })
          }
        />
        <div className="pane chat" style={{ width: ui.chatWidth }}>
          <ErrorBoundary label="The agent panel">
            <ChatPanel />
          </ErrorBoundary>
        </div>
      </div>

      <StatusBar />

      <PermissionDialog />
      <UpdateToast />
      <TaskToast />
      {ui.settingsOpen && (
        <ErrorBoundary label="Settings">
          <SettingsModal />
        </ErrorBoundary>
      )}
      {!settings.setupCompleted && <SetupWizard />}
    </div>
  )
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}
