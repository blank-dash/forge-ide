import { useEffect, useState } from 'react'
import { useStore } from '../store'
import DiffView from './DiffView'
import { useT } from '../i18n'

/**
 * The Cursor-style review screen: every file the agent touched since the last
 * accept, each with its own diff and its own accept/revert.
 */
export default function ReviewPanel() {
  const t = useT()
  const changes = useStore((state) => state.changes)
  const setChanges = useStore((state) => state.setChanges)
  const pushError = useStore((state) => state.pushError)
  const patchUi = useStore((state) => state.patchUi)
  const openTab = useStore((state) => state.openTab)

  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState<string | null>(null)

  // Auto-expand while the list is short enough for that to be helpful.
  useEffect(() => {
    if (changes.length > 0 && changes.length <= 3) {
      setExpanded(new Set(changes.map((change) => change.id)))
    }
  }, [changes])

  const run = async (label: string, action: () => Promise<unknown>): Promise<void> => {
    setBusy(label)
    try {
      await action()
      setChanges(await window.forge.changes.list())
    } catch (error) {
      pushError((error as Error).message)
    } finally {
      setBusy(null)
    }
  }

  const totals = changes.reduce(
    (acc, change) => ({ added: acc.added + change.added, removed: acc.removed + change.removed }),
    { added: 0, removed: 0 }
  )

  if (changes.length === 0) {
    return (
      <div className="pane editor-pane">
        <div className="pane-header">{t('Review')}</div>
        <div className="welcome">
          <h2>{t('Nothing to review')}</h2>
          <p>{t('Changes the agent makes in review mode collect here.')}</p>
          <button className="btn" onClick={() => patchUi({ mainView: 'editor' })}>
            {t('Back to the editor')}
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="pane editor-pane">
      <div className="pane-header">
        {t('Review')}
        <span className="review-count">
          {changes.length} file{changes.length === 1 ? '' : 's'} ·{' '}
          <span className="add">+{totals.added}</span> <span className="del">-{totals.removed}</span>
        </span>
        <span style={{ flex: 1 }} />
        <button
          className="btn btn-primary"
          disabled={busy !== null}
          onClick={() => void run('all', () => window.forge.changes.acceptAll())}
        >
          {t('Keep all')}
        </button>
        <button
          className="btn btn-danger"
          disabled={busy !== null}
          onClick={() => void run('all', () => window.forge.changes.rejectAll())}
        >
          {t('Revert all')}
        </button>
      </div>

      <div className="review-scroll">
        {changes.map((change) => {
          const open = expanded.has(change.id)
          return (
            <div className="review-card" key={change.id}>
              <div className="review-head">
                <button
                  className="review-toggle"
                  onClick={() =>
                    setExpanded((current) => {
                      const next = new Set(current)
                      if (next.has(change.id)) next.delete(change.id)
                      else next.add(change.id)
                      return next
                    })
                  }
                >
                  <span className={`tree-caret ${open ? 'open' : ''}`}>▶</span>
                  <span className={`badge ${change.kind === 'create' ? 'ok' : ''}`}>
                    {change.kind === 'create' ? 'new' : 'edit'}
                  </span>
                  <span className="review-path">{change.path}</span>
                  <span className="add">+{change.added}</span>
                  <span className="del">-{change.removed}</span>
                </button>

                <button
                  className="icon-btn"
                  title="Open in the editor"
                  onClick={async () => {
                    try {
                      const content = await window.forge.workspace.read(change.path)
                      openTab(change.path, content)
                    } catch (error) {
                      pushError((error as Error).message)
                    }
                  }}
                >
                  open
                </button>
                <button
                  className="btn"
                  disabled={busy !== null}
                  onClick={() => void run(change.id, () => window.forge.changes.accept(change.id))}
                >
                  {t('Keep')}
                </button>
                <button
                  className="btn btn-danger"
                  disabled={busy !== null}
                  onClick={() => void run(change.id, () => window.forge.changes.reject(change.id))}
                >
                  {t('Revert')}
                </button>
              </div>

              {open && <DiffView diff={change.diff} className="review-diff" />}
            </div>
          )
        })}
      </div>
    </div>
  )
}
