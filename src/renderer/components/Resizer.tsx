import { useCallback, useRef, useState } from 'react'

interface Props {
  axis: 'x' | 'y'
  /** Movement since the last event, in pixels along the given axis. */
  onDelta(delta: number): void
}

export default function Resizer({ axis, onDelta }: Props): JSX.Element {
  const [dragging, setDragging] = useState(false)
  const last = useRef(0)

  const onPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      event.preventDefault()
      const element = event.currentTarget
      element.setPointerCapture(event.pointerId)
      last.current = axis === 'x' ? event.clientX : event.clientY
      setDragging(true)
    },
    [axis]
  )

  const onPointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (!dragging) return
      const current = axis === 'x' ? event.clientX : event.clientY
      const delta = current - last.current
      if (delta === 0) return
      last.current = current
      onDelta(delta)
    },
    [axis, dragging, onDelta]
  )

  const stop = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    event.currentTarget.releasePointerCapture(event.pointerId)
    setDragging(false)
  }, [])

  return (
    <div
      className={`resizer ${axis === 'y' ? 'resizer-h' : ''} ${dragging ? 'active' : ''}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={stop}
      onPointerCancel={stop}
      role="separator"
      aria-orientation={axis === 'x' ? 'vertical' : 'horizontal'}
    />
  )
}
