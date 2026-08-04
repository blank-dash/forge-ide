import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'

export interface MenuAction {
  kind?: 'item'
  icon?: string
  label: string
  shortcut?: string
  danger?: boolean
  disabled?: boolean
  /** Renders a submenu arrow and opens `children` on hover. */
  children?: MenuItem[]
  onSelect?(): void | Promise<void>
}

export type MenuItem = MenuAction | { kind: 'separator' } | { kind: 'header'; label: string }

type Props = {
  items: MenuItem[]
  onClose(): void
  /** Which corner the menu grows from, relative to its trigger. */
  align?: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'
  header?: ReactNode
}

/**
 * A popover menu that draws itself, for the same reason the dropdown does:
 * the platform menu ignores the app's theme and cannot carry descriptions.
 */
export default function Menu({ items, onClose, align = 'top-left', header }: Props) {
  const root = useRef<HTMLDivElement>(null)
  const [openSub, setOpenSub] = useState<string | null>(null)
  const [flip, setFlip] = useState(false)

  useEffect(() => {
    const onPointerDown = (event: MouseEvent): void => {
      if (!root.current?.contains(event.target as Node)) onClose()
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  // Keep a submenu on screen when the parent sits near the right edge.
  useLayoutEffect(() => {
    if (!root.current) return
    setFlip(window.innerWidth - root.current.getBoundingClientRect().right < 240)
  }, [openSub])

  const render = (item: MenuItem, index: number): ReactNode => {
    if (item.kind === 'separator') return <div className="menu-separator" key={`sep-${index}`} />
    if (item.kind === 'header') {
      return (
        <div className="menu-header" key={`head-${index}`}>
          {item.label}
        </div>
      )
    }

    const entry: MenuAction = item
    const hasChildren = (entry.children?.length ?? 0) > 0

    return (
      <div
        className="menu-row"
        key={entry.label}
        onMouseEnter={() => setOpenSub(hasChildren ? entry.label : null)}
      >
        <button
          className={`menu-item ${entry.danger ? 'danger' : ''}`}
          disabled={entry.disabled}
          onClick={() => {
            if (hasChildren) {
              setOpenSub(openSub === entry.label ? null : entry.label)
              return
            }
            void entry.onSelect?.()
            onClose()
          }}
        >
          {entry.icon && <span className="menu-icon">{entry.icon}</span>}
          <span className="menu-label">{entry.label}</span>
          {entry.shortcut && <span className="menu-shortcut">{entry.shortcut}</span>}
          {hasChildren && <span className="menu-arrow">›</span>}
        </button>

        {hasChildren && openSub === entry.label && (
          <div className={`menu menu-sub ${flip ? 'flip' : ''}`}>
            {entry.children!.map((child, childIndex) => render(child, childIndex))}
          </div>
        )}
      </div>
    )
  }

  return (
    <div className={`menu menu-${align}`} ref={root} role="menu">
      {header}
      {items.map(render)}
    </div>
  )
}
