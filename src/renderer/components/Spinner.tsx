import { useEffect, useState } from 'react'

/** The classic four-frame ASCII spinner. */
const FRAMES = ['|', '/', String.fromCharCode(45), String.fromCharCode(92)]
const PERIOD_MS = 110

/*
 * One timer drives every spinner on screen. Each component owning its own
 * interval would put them out of phase, which reads as jitter when two are
 * visible at once — the title bar and a streaming reply, say.
 */
let frame = 0
let timer: ReturnType<typeof setInterval> | null = null
const listeners = new Set<(value: number) => void>()

function subscribe(listener: (value: number) => void): () => void {
  listeners.add(listener)
  if (!timer) {
    timer = setInterval(() => {
      frame = (frame + 1) % FRAMES.length
      for (const notify of listeners) notify(frame)
    }, PERIOD_MS)
  }
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0 && timer) {
      clearInterval(timer)
      timer = null
    }
  }
}

type Props = {
  /** Stops the animation and shows a steady frame. */
  paused?: boolean
  className?: string
}

/**
 * Text spinner used wherever the agent is working. Deliberately a character
 * rather than an animated logo: it sits on the text baseline, costs nothing to
 * render, and stays legible at the sizes the status bar uses.
 */
export default function Spinner({ paused = false, className }: Props) {
  const [index, setIndex] = useState(frame)
  const still = paused || prefersReducedMotion()

  useEffect(() => {
    if (still) return
    return subscribe(setIndex)
  }, [still])

  return (
    <span className={`ascii-spinner ${className ?? ''}`} aria-hidden="true">
      {FRAMES[still ? 0 : index]}
    </span>
  )
}

function prefersReducedMotion(): boolean {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
}
