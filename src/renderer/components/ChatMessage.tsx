import { useEffect, useRef, useState } from 'react'
import type { ChatEntry } from '../store'
import { useStore } from '../store'
import Spinner from './Spinner'
import Markdown from './Markdown'
import ToolBlock from './ToolBlock'
import { isSpeaking, speak, stopSpeaking } from '../voice'

export default function ChatMessage({ entry }: { entry: ChatEntry }): JSX.Element {
  const showThinking = useStore((state) => state.settings.showThinking)

  if (entry.role === 'user') {
    const text = entry.blocks.map((block) => (block.kind === 'text' ? block.text : '')).join('')
    const images = entry.attachments?.filter((entry_) => entry_.kind === 'image') ?? []

    return (
      <div className="msg msg-user">
        <span className="caret">&gt;</span>
        <span className="text">
          {text}
          {images.length > 0 && (
            <span className="msg-thumbs">
              {images.map((image) => (
                <img
                  key={image.id}
                  src={image.kind === 'image' ? image.preview : ''}
                  alt={image.name}
                  title={image.name}
                />
              ))}
            </span>
          )}
        </span>
      </div>
    )
  }

  return (
    <div className="msg msg-assistant">
      {entry.blocks.map((block, index) => {
        if (block.kind === 'thinking') {
          return showThinking ? <Thinking key={index} text={block.text} /> : null
        }
        if (block.kind === 'tool') {
          return <ToolBlock key={block.use.id || index} use={block.use} result={block.result} />
        }
        return (
          <div className="text" key={index}>
            <Markdown text={block.text} />
            {entry.streaming && index === entry.blocks.length - 1 && <Cursor />}
          </div>
        )
      })}

      {entry.streaming && entry.blocks.length === 0 && (
        <div className="thinking-line">
          <Spinner />
          <span>thinking…</span>
        </div>
      )}

      {!entry.streaming && entry.usage && (
        <div className="turn-footer">
          <TurnStats entry={entry} />
          <SpeakButton entry={entry} />
        </div>
      )}
    </div>
  )
}

function Thinking({ text }: { text: string }): JSX.Element {
  const [open, setOpen] = useState(false)
  const preview = text.trim().split('\n').at(-1)?.slice(0, 90) ?? ''

  return (
    <div>
      <button className="thinking-toggle" onClick={() => setOpen((value) => !value)}>
        {open ? '▾ thinking' : `▸ thinking — ${preview}`}
      </button>
      {open && <div className="thinking">{text}</div>}
    </div>
  )
}

function Cursor(): JSX.Element {
  return (
    <span
      style={{
        display: 'inline-block',
        width: 7,
        height: '1em',
        marginLeft: 2,
        verticalAlign: 'text-bottom',
        background: 'var(--accent)',
        animation: 'pulse 1s steps(2, start) infinite'
      }}
    />
  )
}

/**
 * Reads a finished reply aloud.
 *
 * Auto-speaking is opt-in and fires once per reply. The ref, rather than a
 * state flag, is what stops a re-render — a sibling message streaming, a theme
 * change — from starting the same reply over from the top.
 */
function SpeakButton({ entry }: { entry: ChatEntry }): JSX.Element | null {
  const voice = useStore((state) => state.settings.voice)
  const [busy, setBusy] = useState(false)
  const spoken = useRef(false)

  const text = entry.blocks.map((block) => (block.kind === 'text' ? block.text : '')).join(' ')

  const live = useStore((state) => state.live)

  useEffect(() => {
    // Sharing a screen means you are looking at something else. Reading the
    // reply aloud is the whole point of the mode, so it does not wait for the
    // "read every reply" preference to have been found and switched on.
    const wanted = voice.autoSpeak || live?.active === true
    if (!wanted || voice.speak === 'off' || spoken.current || !text.trim()) return

    spoken.current = true
    void speak(text).catch(() => undefined)
  }, [voice.autoSpeak, voice.speak, live?.active, text])

  if (voice.speak === 'off' || !text.trim()) return null

  return (
    <button
      className="speak-btn"
      title={busy ? 'Stop reading' : 'Read this aloud'}
      onClick={() => {
        if (isSpeaking()) {
          stopSpeaking()
          setBusy(false)
          return
        }
        setBusy(true)
        void speak(text)
          .catch((error: Error) => useStore.getState().pushError(error.message))
          .finally(() => setBusy(false))
      }}
    >
      {busy ? '■' : '🔊'}
    </button>
  )
}

/**
 * What the turn cost, once it is done. Shown after the fact rather than live —
 * a number moving while you read is a distraction, not information.
 */
function TurnStats({ entry }: { entry: ChatEntry }) {
  const usage = entry.usage
  if (!usage) return null

  const parts: string[] = []
  if (entry.durationMs) parts.push(formatDuration(entry.durationMs))
  if (usage.input) parts.push(`${compact(usage.input)} in`)
  if (usage.output) parts.push(`${compact(usage.output)} out`)
  if (usage.reasoning) parts.push(`${compact(usage.reasoning)} thinking`)
  if (usage.cacheRead) parts.push(`${compact(usage.cacheRead)} cached`)
  if (usage.costUsd > 0) parts.push(`$${usage.costUsd.toFixed(4)}`)

  if (parts.length === 0) return null

  return (
    <div className="turn-stats">
      {parts.map((part, index) => (
        <span key={part + index}>
          {index > 0 && <span className="sep">· </span>}
          {part}
        </span>
      ))}
    </div>
  )
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const minutes = Math.floor(ms / 60_000)
  return `${minutes}m ${Math.round((ms % 60_000) / 1000)}s`
}

function compact(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1000) return `${(value / 1000).toFixed(1)}k`
  return String(value)
}
