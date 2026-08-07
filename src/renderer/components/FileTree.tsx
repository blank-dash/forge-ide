import { basename } from '@shared/paths'
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { FileEntry } from '@shared/types'
import { useStore } from '../store'

export default function FileTree(): JSX.Element {
  const [children, setChildren] = useState<Record<string, FileEntry[]>>({})
  const [expanded, setExpanded] = useState<Set<string>>(new Set(['.']))
  const [error, setError] = useState<string | null>(null)

  const activeTab = useStore((state) => state.activeTab)
  const changedFiles = useStore((state) => state.changedFiles)
  const fsRevision = useStore((state) => state.fsRevision)
  const openTab = useStore((state) => state.openTab)
  const setActiveTab = useStore((state) => state.setActiveTab)

  const changedRelative = useMemo(() => {
    // The agent reports absolute paths; the tree speaks relative ones.
    const set = new Set<string>()
    for (const absolute of changedFiles) {
      set.add(basename(absolute))
    }
    return set
  }, [changedFiles])

  const load = useCallback(async (path: string) => {
    try {
      const entries = await window.forge.workspace.list(path)
      setChildren((current) => ({ ...current, [path]: entries }))
      setError(null)
    } catch (err) {
      setError((err as Error).message)
    }
  }, [])

  // Reload every open folder whenever something on disk changed, so files the
  // agent created show up without the user having to hit refresh.
  useEffect(() => {
    void load('.')
    for (const path of expanded) if (path !== '.') void load(path)
    // `expanded` intentionally excluded: toggling already loads its own folder.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load, fsRevision])

  const toggle = useCallback(
    (entry: FileEntry) => {
      setExpanded((current) => {
        const next = new Set(current)
        if (next.has(entry.path)) {
          next.delete(entry.path)
        } else {
          next.add(entry.path)
          if (!children[entry.path]) void load(entry.path)
        }
        return next
      })
    },
    [children, load]
  )

  const open = useCallback(
    async (entry: FileEntry) => {
      const existing = useStore.getState().tabs.find((tab) => tab.path === entry.path)
      if (existing) {
        setActiveTab(entry.path)
        return
      }
      try {
        const content = await window.forge.workspace.read(entry.path)
        openTab(entry.path, content)
      } catch (err) {
        setError(`${entry.name}: ${(err as Error).message}`)
      }
    },
    [openTab, setActiveTab]
  )

  const renderLevel = (path: string, depth: number): JSX.Element[] => {
    const entries = children[path] ?? []
    return entries.flatMap((entry) => {
      const isOpen = expanded.has(entry.path)
      const row = (
        <button
          key={entry.path}
          className={[
            'tree-row',
            activeTab === entry.path ? 'active' : '',
            !entry.isDirectory && changedRelative.has(entry.name) ? 'changed' : ''
          ]
            .filter(Boolean)
            .join(' ')}
          style={{ paddingLeft: 6 + depth * 11 }}
          onClick={() => (entry.isDirectory ? toggle(entry) : void open(entry))}
          title={entry.path}
        >
          <span className={`tree-caret ${isOpen ? 'open' : ''}`}>
            {entry.isDirectory ? '▶' : ''}
          </span>
          <span className="tree-icon">{entry.isDirectory ? '📁' : fileIcon(entry.name)}</span>
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{entry.name}</span>
        </button>
      )

      return entry.isDirectory && isOpen ? [row, ...renderLevel(entry.path, depth + 1)] : [row]
    })
  }

  return (
    <>
      <div className="pane-header">
        Explorer
        <span style={{ flex: 1 }} />
        <button
          className="icon-btn"
          onClick={() => {
            setChildren({})
            void load('.')
            for (const path of expanded) if (path !== '.') void load(path)
          }}
          title="Refresh"
        >
          ⟳
        </button>
      </div>

      <div className="tree">
        {error && <div className="empty-hint">{error}</div>}
        {renderLevel('.', 0)}
        {(children['.'] ?? []).length === 0 && !error && (
          <div className="empty-hint">This folder is empty.</div>
        )}
      </div>
    </>
  )
}

const ICONS: Record<string, string> = {
  ts: '🟦',
  tsx: '🟦',
  js: '🟨',
  jsx: '🟨',
  json: '🟧',
  md: '📝',
  css: '🎨',
  html: '🌐',
  py: '🐍',
  rs: '🦀',
  go: '🐹',
  sh: '⚙️',
  yml: '⚙️',
  yaml: '⚙️'
}

function fileIcon(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase() ?? ''
  return ICONS[ext] ?? '📄'
}
