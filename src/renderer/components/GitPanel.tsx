import { useCallback, useEffect, useState } from 'react'
import type { GitFile } from '@shared/types'
import { useStore } from '../store'
import DiffView from './DiffView'

export default function GitPanel() {
  const git = useStore((state) => state.git)
  const setGit = useStore((state) => state.setGit)
  const pushError = useStore((state) => state.pushError)
  const fsRevision = useStore((state) => state.fsRevision)
  const gitAvailable = useStore((state) => state.bootstrap?.gitAvailable ?? false)

  const [message, setMessage] = useState('')
  const [selected, setSelected] = useState<GitFile | null>(null)
  const [diff, setDiff] = useState('')
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async () => {
    try {
      setGit(await window.forge.git.status())
    } catch (error) {
      pushError((error as Error).message)
    }
  }, [pushError, setGit])

  useEffect(() => {
    void refresh()
  }, [refresh, fsRevision])

  // Cheap safety net for changes made outside the app (a terminal commit, say).
  useEffect(() => {
    const timer = setInterval(() => void refresh(), 8000)
    return () => clearInterval(timer)
  }, [refresh])

  useEffect(() => {
    if (!selected) {
      setDiff('')
      return
    }
    let cancelled = false
    void window.forge.git
      .diff(selected.path, selected.staged)
      .then((value) => {
        if (!cancelled) setDiff(value || '(no textual diff — the file may be new or binary)')
      })
      .catch((error: Error) => {
        if (!cancelled) setDiff(error.message)
      })
    return () => {
      cancelled = true
    }
  }, [selected, fsRevision])

  const act = async (action: () => Promise<unknown>): Promise<void> => {
    setBusy(true)
    try {
      await action()
      await refresh()
    } catch (error) {
      pushError((error as Error).message)
    } finally {
      setBusy(false)
    }
  }

  if (!gitAvailable) {
    return (
      <>
        <div className="pane-header">Source control</div>
        <div className="empty-hint">
          The <code>git</code> command was not found on this machine. Install git and reopen Forge.
        </div>
      </>
    )
  }

  if (!git?.isRepo) {
    return (
      <>
        <div className="pane-header">Source control</div>
        <div className="empty-hint">
          {git?.error ? git.error : 'This folder is not a git repository.'}
        </div>
      </>
    )
  }

  const staged = git.files.filter((file) => file.staged)
  const unstaged = git.files.filter((file) => !file.staged || file.partiallyStaged)

  return (
    <>
      <div className="pane-header">
        Source control
        <span style={{ flex: 1 }} />
        <button className="icon-btn" onClick={() => void refresh()} title="Refresh">
          ⟳
        </button>
      </div>

      <div className="git-branch">
        <span className="pill accent">{git.branch || 'detached'}</span>
        {git.upstream && (
          <span className="git-track">
            ↑{git.ahead} ↓{git.behind}
          </span>
        )}
      </div>

      <div className="git-commit">
        <textarea
          className="textarea"
          style={{ minHeight: 54 }}
          placeholder="Commit message"
          value={message}
          onChange={(event) => setMessage(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
              event.preventDefault()
              void act(async () => {
                await window.forge.git.commit(message, staged.length === 0)
                setMessage('')
              })
            }
          }}
        />
        <div className="row" style={{ marginTop: 6 }}>
          <button
            className="btn btn-primary"
            disabled={busy || !message.trim() || git.files.length === 0}
            onClick={() =>
              void act(async () => {
                await window.forge.git.commit(message, staged.length === 0)
                setMessage('')
              })
            }
          >
            {staged.length > 0 ? `Commit ${staged.length} staged` : 'Stage all & commit'}
          </button>
        </div>
      </div>

      <div className="tree" style={{ flex: 1 }}>
        {git.files.length === 0 && <div className="empty-hint">Working tree clean.</div>}

        <FileGroup
          title={`Staged (${staged.length})`}
          files={staged}
          selected={selected}
          onSelect={setSelected}
          actionLabel="unstage"
          onAction={(file) => void act(() => window.forge.git.unstage([bare(file.path)]))}
          busy={busy}
          onStageAll={
            staged.length > 0
              ? () => void act(() => window.forge.git.unstage(staged.map((f) => bare(f.path))))
              : undefined
          }
          stageAllLabel="unstage all"
        />

        <FileGroup
          title={`Changes (${unstaged.length})`}
          files={unstaged}
          selected={selected}
          onSelect={setSelected}
          actionLabel="stage"
          onAction={(file) => void act(() => window.forge.git.stage([bare(file.path)]))}
          busy={busy}
          onStageAll={
            unstaged.length > 0
              ? () => void act(() => window.forge.git.stage(unstaged.map((f) => bare(f.path))))
              : undefined
          }
          stageAllLabel="stage all"
        />
      </div>

      {selected && (
        <div className="git-diff">
          <div className="pane-header">
            {selected.path}
            <span style={{ flex: 1 }} />
            <button className="icon-btn" onClick={() => setSelected(null)}>
              ×
            </button>
          </div>
          <DiffView diff={diff} className="git-diff-body" />
        </div>
      )}
    </>
  )
}

type GroupProps = {
  title: string
  files: GitFile[]
  selected: GitFile | null
  busy: boolean
  actionLabel: string
  stageAllLabel: string
  onSelect(file: GitFile): void
  onAction(file: GitFile): void
  onStageAll?(): void
}

function FileGroup({
  title,
  files,
  selected,
  busy,
  actionLabel,
  stageAllLabel,
  onSelect,
  onAction,
  onStageAll
}: GroupProps) {
  if (files.length === 0) return null

  return (
    <>
      <div className="git-group">
        {title}
        <span style={{ flex: 1 }} />
        {onStageAll && (
          <button className="icon-btn" disabled={busy} onClick={onStageAll}>
            {stageAllLabel}
          </button>
        )}
      </div>
      {files.map((file) => (
        <div
          key={`${file.staged ? 's' : 'u'}:${file.path}`}
          className={`tree-row ${selected?.path === file.path && selected.staged === file.staged ? 'active' : ''}`}
          onClick={() => onSelect(file)}
          role="button"
        >
          <span className={`git-state git-${file.state}`}>{STATE_MARK[file.state]}</span>
          <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' }}>{file.path}</span>
          <button
            className="icon-btn"
            disabled={busy}
            onClick={(event) => {
              event.stopPropagation()
              onAction(file)
            }}
          >
            {actionLabel}
          </button>
        </div>
      ))}
    </>
  )
}

const STATE_MARK: Record<GitFile['state'], string> = {
  modified: 'M',
  added: 'A',
  deleted: 'D',
  renamed: 'R',
  untracked: 'U',
  conflict: '!'
}

/** Renames arrive as "old → new"; git commands need the current path only. */
function bare(path: string): string {
  const arrow = path.indexOf(' → ')
  return arrow === -1 ? path : path.slice(arrow + 3)
}
