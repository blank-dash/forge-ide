import { useEffect, useMemo, useState } from 'react'
import { useT } from '../i18n'
import { useStore } from '../store'
import { findSymbols } from '@shared/outline'
import Palette, { type PaletteItem } from './Palette'
import { startNewConversation } from './ConversationList'

/**
 * The three things the palette is used for.
 *
 * Quick open finds a file, the command palette runs an action, and the outline
 * jumps within the open file. They share the overlay and differ only in what
 * they list.
 */

export function QuickOpen({ onClose }: { onClose: () => void }) {
  const t = useT()
  const [files, setFiles] = useState<string[]>([])
  const openTab = useStore((state) => state.openTab)

  useEffect(() => {
    void window.forge.index.files().then(setFiles).catch(() => setFiles([]))
  }, [])

  const items = useMemo<PaletteItem[]>(
    () =>
      files.map((file) => ({
        id: file,
        label: file,
        run: async () => {
          const content = await window.forge.workspace.read(file).catch(() => null)
          if (content !== null) openTab(file, content)
        }
      })),
    [files, openTab]
  )

  return (
    <Palette
      items={items}
      placeholder={t('Go to file…')}
      empty={t('No file matches that.')}
      onClose={onClose}
    />
  )
}

export function CommandPalette({ onClose }: { onClose: () => void }) {
  const t = useT()
  const items = useCommands()

  return (
    <Palette
      items={items}
      placeholder={t('Type a command…')}
      empty={t('No command matches that.')}
      onClose={onClose}
    />
  )
}

/**
 * Symbols in the open file.
 *
 * Found by pattern rather than by parsing. A real parser per language is a
 * large amount of machinery for a jump list, and a regular expression that
 * knows what a declaration looks like in the handful of shapes these languages
 * share gets the same job done — it is allowed to miss one, because the file is
 * right there.
 */
export function OutlinePicker({ onClose }: { onClose: () => void }) {
  const t = useT()
  const tabs = useStore((state) => state.tabs)
  const activeTab = useStore((state) => state.activeTab)
  const revealLine = useStore((state) => state.revealLine)

  const items = useMemo<PaletteItem[]>(() => {
    const tab = tabs.find((entry) => entry.path === activeTab)
    if (!tab) return []

    return findSymbols(tab.content).map((symbol) => ({
      id: `${symbol.line}-${symbol.name}`,
      label: symbol.name,
      detail: symbol.kind,
      hint: `:${symbol.line}`,
      run: () => revealLine(symbol.line)
    }))
  }, [tabs, activeTab, revealLine])

  return (
    <Palette
      items={items}
      placeholder={t('Go to symbol…')}
      empty={t('No symbols found in this file.')}
      onClose={onClose}
    />
  )
}

/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */

/** Everything the command palette can run. */
function useCommands(): PaletteItem[] {
  const t = useT()
  const store = useStore()

  return useMemo<PaletteItem[]>(() => {
    const ui = (partial: Parameters<typeof store.patchUi>[0]) => () => store.patchUi(partial)

    const commands: PaletteItem[] = [
      { id: 'new-chat', label: t('New conversation'), hint: 'Ctrl+N', run: () => void startNewConversation() },
      { id: 'go-file', label: t('Go to file'), hint: 'Ctrl+P', run: ui({ picker: 'files' }) },
      { id: 'go-symbol', label: t('Go to symbol'), hint: 'Ctrl+Shift+O', run: ui({ picker: 'symbols' }) },
      { id: 'search', label: t('Search across files'), hint: 'Ctrl+Shift+F', run: ui({ sidePanel: 'search', sidebarWidth: 320 }) },

      { id: 'mode-chat', label: t('Switch to Chat'), hint: 'Ctrl+1', run: () => void store.saveSettings({ mode: 'chat' }) },
      { id: 'mode-edit', label: t('Switch to Work'), hint: 'Ctrl+2', run: () => void store.saveSettings({ mode: 'agent' }) },

      { id: 'pane-dashboard', label: t('Dashboard'), run: () => { void store.saveSettings({ mode: 'chat' }); store.patchUi({ chatPane: 'dashboard' }) } },
      { id: 'pane-tasks', label: t('Scheduled tasks'), run: () => { void store.saveSettings({ mode: 'chat' }); store.patchUi({ chatPane: 'tasks' }) } },
      { id: 'pane-browser', label: t('Browser'), run: () => { void store.saveSettings({ mode: 'chat' }); store.patchUi({ chatPane: 'browser' }) } },
      { id: 'pane-live', label: t('Live mode'), run: () => { void store.saveSettings({ mode: 'chat' }); store.patchUi({ chatPane: 'live' }) } },
      { id: 'pane-checkpoints', label: t('Checkpoints'), run: () => { void store.saveSettings({ mode: 'chat' }); store.patchUi({ chatPane: 'checkpoints' }) } },

      { id: 'terminal', label: t('Toggle terminal'), hint: 'Ctrl+`', run: () => store.patchUi({ terminalOpen: !store.ui.terminalOpen }) },
      { id: 'sidebar', label: t('Toggle sidebar'), hint: 'Ctrl+B', run: () => store.patchUi({ sidebarWidth: store.ui.sidebarWidth > 0 ? 0 : 240 }) },
      { id: 'review', label: t('Review changes'), hint: 'Ctrl+Shift+R', run: ui({ mainView: 'review' }) },
      { id: 'git', label: t('Source control'), hint: 'Ctrl+Shift+G', run: ui({ sidePanel: 'git', sidebarWidth: 260 }) },

      { id: 'export', label: t('Export this conversation to Markdown'), run: () => void store.exportConversation() },

      { id: 'settings', label: t('Settings'), hint: 'Ctrl+,', run: ui({ settingsOpen: true }) },
      { id: 'settings-providers', label: t('Settings: Providers & models'), run: ui({ settingsOpen: true, settingsSection: 'providers' }) },
      { id: 'settings-voice', label: t('Settings: Voice'), run: ui({ settingsOpen: true, settingsSection: 'voice' }) },
      { id: 'settings-appearance', label: t('Settings: Appearance'), run: ui({ settingsOpen: true, settingsSection: 'appearance' }) },
      { id: 'settings-prompts', label: t('Settings: Prompt library'), run: ui({ settingsOpen: true, settingsSection: 'prompts' }) },
      { id: 'settings-permissions', label: t('Settings: Permissions'), run: ui({ settingsOpen: true, settingsSection: 'permissions' }) },

      { id: 'read-only', label: t('Read-only: look but do not touch'), run: () => void store.saveSettings({ readOnly: true, bypassPermissions: false }) },
      { id: 'unlock', label: t('Allow edits again'), run: () => void store.saveSettings({ readOnly: false }) },
      { id: 'bypass', label: t('Approve everything without asking'), run: () => void store.saveSettings({ bypassPermissions: true, readOnly: false }) }
    ]

    return commands
  }, [store, t])
}
