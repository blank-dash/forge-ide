import { useEffect, useMemo, useRef, useState } from 'react'
import { fuzzyRank, type FuzzyMatch } from '@shared/fuzzy'

export interface PaletteItem {
  id: string
  /** What is matched against, and shown in bold. */
  label: string
  /** Second line: a path, a description, a keyboard shortcut. */
  detail?: string
  /** Right-aligned, for shortcuts or kinds. */
  hint?: string
  run(): void | Promise<void>
}

type Props = {
  items: PaletteItem[]
  placeholder: string
  onClose(): void
  /** Shown when nothing matches, instead of an empty box. */
  empty?: string
  /** Prefills the box, e.g. the word under the cursor. */
  initialQuery?: string
}

const MAX_SHOWN = 60

/**
 * The overlay behind quick open, the command palette and the symbol list.
 *
 * One component for all three because they are the same interaction — type,
 * arrow, enter — and three copies of it would drift apart in exactly the small
 * ways that make a picker feel wrong: which key wraps, what happens on empty,
 * whether the selection survives a keystroke.
 */
export default function Palette({ items, placeholder, onClose, empty, initialQuery }: Props) {
  const [query, setQuery] = useState(initialQuery ?? '')
  const [active, setActive] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLInputElement>(null)

  const ranked = useMemo(
    () => fuzzyRank(query, items, (item) => item.label, MAX_SHOWN),
    [query, items]
  )

  // Any keystroke that changes the list invalidates where the cursor was.
  useEffect(() => setActive(0), [query])

  useEffect(() => {
    input.current?.focus()
    input.current?.select()
  }, [])

  // Keeps the highlighted row on screen when arrowing past the fold.
  useEffect(() => {
    const row = listRef.current?.children[active] as HTMLElement | undefined
    row?.scrollIntoView({ block: 'nearest' })
  }, [active])

  const choose = (index: number): void => {
    const item = ranked[index]?.item
    if (!item) return
    // Closed first: an action that opens something else should not have this
    // overlay reappear on top of it.
    onClose()
    void item.run()
  }

  return (
    <div className="palette-backdrop" onMouseDown={onClose}>
      <div className="palette" onMouseDown={(event) => event.stopPropagation()}>
        <input
          ref={input}
          className="palette-input"
          value={query}
          placeholder={placeholder}
          spellCheck={false}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown' || (event.key === 'n' && event.ctrlKey)) {
              event.preventDefault()
              // Wraps, so holding down at the end returns to the top rather
              // than doing nothing.
              setActive((current) => (ranked.length ? (current + 1) % ranked.length : 0))
            } else if (event.key === 'ArrowUp' || (event.key === 'p' && event.ctrlKey)) {
              event.preventDefault()
              setActive((current) =>
                ranked.length ? (current - 1 + ranked.length) % ranked.length : 0
              )
            } else if (event.key === 'Enter') {
              event.preventDefault()
              choose(active)
            } else if (event.key === 'Escape') {
              event.preventDefault()
              onClose()
            }
          }}
        />

        <div className="palette-list" ref={listRef}>
          {ranked.length === 0 && (
            <div className="palette-empty">{empty ?? 'Nothing matches.'}</div>
          )}

          {ranked.map((entry, index) => (
            <button
              key={entry.item.id}
              className={`palette-row ${index === active ? 'active' : ''}`}
              // Mouse-down rather than click: the input would blur first and
              // the overlay would close before the click landed.
              onMouseDown={(event) => {
                event.preventDefault()
                choose(index)
              }}
              onMouseEnter={() => setActive(index)}
            >
              <span className="palette-label">{highlight(entry.item.label, entry.match)}</span>
              {entry.item.detail && <span className="palette-detail">{entry.item.detail}</span>}
              {entry.item.hint && <span className="palette-hint">{entry.item.hint}</span>}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

/** Marks the characters the query actually matched. */
function highlight(label: string, match: FuzzyMatch): JSX.Element[] {
  const marked = new Set(match.positions)

  return label.split('').map((character, index) => (
    <span key={index} className={marked.has(index) ? 'palette-hit' : undefined}>
      {character}
    </span>
  ))
}
