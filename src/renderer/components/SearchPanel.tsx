import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { SearchHit, SearchResult } from '../../preload'
import { useT } from '../i18n'
import { useStore } from '../store'

/**
 * Text search across the workspace.
 *
 * Results are grouped by file and collapsed by default once there are many —
 * a flat list of four hundred lines is not a result, it is a wall. Clicking one
 * opens the file at that line.
 */
export default function SearchPanel() {
  const t = useT()
  const [query, setQuery] = useState('')
  const [include, setInclude] = useState('')
  const [regex, setRegex] = useState(false)
  const [caseSensitive, setCaseSensitive] = useState(false)
  const [result, setResult] = useState<SearchResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const openTab = useStore((state) => state.openTab)
  const revealLine = useStore((state) => state.revealLine)
  const input = useRef<HTMLInputElement>(null)

  useEffect(() => input.current?.focus(), [])

  const run = useCallback(async () => {
    if (!query.trim()) {
      setResult(null)
      return
    }

    setBusy(true)
    setError(null)
    try {
      setResult(await window.forge.index.search(query, { regex, caseSensitive, include }))
    } catch (caught) {
      setError((caught as Error).message)
      setResult(null)
    } finally {
      setBusy(false)
    }
  }, [query, regex, caseSensitive, include])

  // Debounced: searching on every keystroke re-reads the workspace, and a
  // repository of any size would make typing feel like wading.
  useEffect(() => {
    const timer = setTimeout(() => void run(), 250)
    return () => clearTimeout(timer)
  }, [run])

  const grouped = useMemo(() => groupByFile(result?.hits ?? []), [result])

  const open = async (hit: SearchHit): Promise<void> => {
    const content = await window.forge.workspace.read(hit.path).catch(() => null)
    if (content === null) return
    openTab(hit.path, content)
    revealLine(hit.line)
  }

  return (
    <>
      <div className="pane-header">{t('Search')}</div>

      <div className="search-form">
        <input
          ref={input}
          className="input"
          value={query}
          placeholder={t('Search across files')}
          spellCheck={false}
          onChange={(event) => setQuery(event.target.value)}
        />
        <input
          className="input mono"
          value={include}
          placeholder={t('Files to include, e.g. *.ts')}
          spellCheck={false}
          onChange={(event) => setInclude(event.target.value)}
        />
        <div className="search-toggles">
          <button
            className={`pill ${caseSensitive ? 'accent' : ''}`}
            title={t('Match case')}
            onClick={() => setCaseSensitive((value) => !value)}
          >
            Aa
          </button>
          <button
            className={`pill ${regex ? 'accent' : ''}`}
            title={t('Regular expression')}
            onClick={() => setRegex((value) => !value)}
          >
            .*
          </button>
          <span style={{ flex: 1 }} />
          {busy && <span className="search-count">{t('searching…')}</span>}
          {!busy && result && (
            <span className="search-count">
              {result.hits.length} {t('in')} {grouped.length} {t('files')}
              {result.truncated ? ' +' : ''}
            </span>
          )}
        </div>
      </div>

      {error && <div className="field-error" style={{ margin: '0 10px' }}>{error}</div>}

      <div className="tree search-results">
        {!busy && query.trim() && result?.hits.length === 0 && (
          <div className="empty-hint">{t('Nothing found.')}</div>
        )}

        {grouped.map(([file, hits]) => (
          <FileGroup key={file} file={file} hits={hits} onOpen={open} />
        ))}

        {result?.truncated && (
          <div className="empty-hint">
            {t('Stopped early — there are more matches than can be shown. Narrow the search.')}
          </div>
        )}
      </div>
    </>
  )
}

function FileGroup({
  file,
  hits,
  onOpen
}: {
  file: string
  hits: SearchHit[]
  onOpen(hit: SearchHit): void
}) {
  // Collapsed when a single file swamps the list; open otherwise, because the
  // usual case is a handful of hits you want to read without another click.
  const [open, setOpen] = useState(hits.length <= 12)

  return (
    <div className="search-group">
      <button className="search-file" onClick={() => setOpen((value) => !value)}>
        <span className="search-caret">{open ? '▾' : '▸'}</span>
        <span className="search-path">{file}</span>
        <span className="search-n">{hits.length}</span>
      </button>

      {open &&
        hits.map((hit) => (
          <button
            key={`${hit.line}-${hit.start}`}
            className="search-hit"
            onClick={() => onOpen(hit)}
          >
            <span className="search-line">{hit.line}</span>
            <span className="search-text">
              {hit.text.slice(0, hit.start)}
              <mark>{hit.text.slice(hit.start, hit.end)}</mark>
              {hit.text.slice(hit.end)}
            </span>
          </button>
        ))}
    </div>
  )
}

/** Keeps file order as the search produced it, which is shallowest-first. */
function groupByFile(hits: SearchHit[]): Array<[string, SearchHit[]]> {
  const groups = new Map<string, SearchHit[]>()
  for (const hit of hits) {
    const list = groups.get(hit.path)
    if (list) list.push(hit)
    else groups.set(hit.path, [hit])
  }
  return [...groups.entries()]
}
