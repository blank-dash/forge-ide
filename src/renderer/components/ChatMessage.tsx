import { useState } from 'react'
import type { ChatEntry } from '../store'
import { useStore } from '../store'
import Markdown from './Markdown'
import ToolBlock from './ToolBlock'

export default function ChatMessage({ entry }: { entry: ChatEntry }): JSX.Element {
  const showThinking = useStore((state) => state.settings.showThinking)

  if (entry.role === 'user') {
    const text = entry.blocks.map((block) => (block.kind === 'text' ? block.text : '')).join('')
    return (
      <div className="msg msg-user">
        <span className="caret">&gt;</span>
        <span className="text">{text}</span>
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
        <div className="text" style={{ color: 'var(--fg-3)' }}>
          thinking<Cursor />
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
