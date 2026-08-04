import { Fragment, type ReactNode } from 'react'

/**
 * Deliberately tiny markdown renderer: fenced code, inline code, bold and
 * bullet markers. Everything is rendered as React nodes — no HTML injection,
 * because this text comes from a model.
 */
export default function Markdown({ text }: { text: string }): JSX.Element {
  return <>{renderBlocks(text)}</>
}

function renderBlocks(text: string): ReactNode[] {
  const out: ReactNode[] = []
  const parts = text.split(/```/)

  parts.forEach((part, index) => {
    if (index % 2 === 1) {
      // Inside a fence: the first line may be a language tag.
      const newline = part.indexOf('\n')
      const firstLine = newline === -1 ? part : part.slice(0, newline)
      const isLang = /^[a-z0-9+#.-]*$/i.test(firstLine.trim())
      const code = isLang && newline !== -1 ? part.slice(newline + 1) : part
      out.push(
        <pre key={`code-${index}`}>
          <code>{code.replace(/\n$/, '')}</code>
        </pre>
      )
    } else if (part) {
      out.push(<Fragment key={`text-${index}`}>{renderInline(part)}</Fragment>)
    }
  })

  return out
}

function renderInline(text: string): ReactNode[] {
  const out: ReactNode[] = []
  // Split on inline code first so bold markers inside code stay literal.
  const segments = text.split(/(`[^`\n]+`)/)

  segments.forEach((segment, index) => {
    if (segment.startsWith('`') && segment.endsWith('`') && segment.length > 2) {
      out.push(<code key={`ic-${index}`}>{segment.slice(1, -1)}</code>)
      return
    }

    const bold = segment.split(/(\*\*[^*]+\*\*)/)
    bold.forEach((chunk, boldIndex) => {
      if (chunk.startsWith('**') && chunk.endsWith('**') && chunk.length > 4) {
        out.push(<strong key={`b-${index}-${boldIndex}`}>{chunk.slice(2, -2)}</strong>)
      } else if (chunk) {
        out.push(<Fragment key={`t-${index}-${boldIndex}`}>{chunk}</Fragment>)
      }
    })
  })

  return out
}
