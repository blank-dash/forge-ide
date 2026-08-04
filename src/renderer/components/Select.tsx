import { useEffect, useLayoutEffect, useRef, useState } from 'react'

export type SelectOption<T extends string> = {
  value: T
  label: string
  /** Second line, for options that need explaining. */
  hint?: string
}

type Props<T extends string> = {
  value: T
  options: SelectOption<T>[]
  onChange(next: T): void
  /** `mini` matches the pills in the composer row. */
  size?: 'normal' | 'mini'
  title?: string
  disabled?: boolean
}

/**
 * A dropdown that obeys the theme.
 *
 * A native `<select>` renders its list with the operating system's own widget,
 * which ignores every CSS variable here — on a dark theme that means grey text
 * on a white popup. This draws the list itself, so it is readable in every
 * theme and has room for a description under each option.
 */
export default function Select<T extends string>({
  value,
  options,
  onChange,
  size = 'normal',
  title,
  disabled
}: Props<T>) {
  const [open, setOpen] = useState(false)
  const [above, setAbove] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const current = options.find((option) => option.value === value)

  useEffect(() => {
    if (!open) return

    const onPointerDown = (event: MouseEvent): void => {
      if (!root.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }

    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  // Flip upwards when there is no room below — the composer sits at the bottom.
  useLayoutEffect(() => {
    if (!open || !root.current) return
    const box = root.current.getBoundingClientRect()
    const needed = Math.min(options.length * 46 + 16, 320)
    setAbove(window.innerHeight - box.bottom < needed)
  }, [open, options.length])

  return (
    <div className={`select-root ${size}`} ref={root} title={title}>
      <button
        type="button"
        className={`select-trigger ${open ? 'open' : ''}`}
        disabled={disabled}
        onClick={() => setOpen((value_) => !value_)}
      >
        <span className="select-value">{current?.label ?? value}</span>
        <span className="select-caret">{open ? '▴' : '▾'}</span>
      </button>

      {open && (
        <div className={`select-list ${above ? 'above' : ''}`} role="listbox">
          {options.map((option) => (
            <button
              type="button"
              key={option.value}
              role="option"
              aria-selected={option.value === value}
              className={`select-option ${option.value === value ? 'active' : ''}`}
              onClick={() => {
                onChange(option.value)
                setOpen(false)
              }}
            >
              <span className="select-check">{option.value === value ? '✓' : ''}</span>
              <span className="select-text">
                <span className="select-label">{option.label}</span>
                {option.hint && <span className="select-hint">{option.hint}</span>}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
