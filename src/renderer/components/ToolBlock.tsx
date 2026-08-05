import { useState } from 'react'
import type { ToolResultBlock, ToolUseBlock } from '@shared/types'

interface Props {
  use: ToolUseBlock
  result?: ToolResultBlock
}

/** The `⏺ Tool(args)` + `⎿ summary` motif, expandable to the full output. */
export default function ToolBlock({ use, result }: Props): JSX.Element {
  const [open, setOpen] = useState(false)

  const running = !result
  const failed = result?.isError === true
  const display = result?.display

  const image = display?.image
  const body = display?.diff ?? display?.body ?? result?.content ?? ''
  // An image is a body too — otherwise a screenshot tool looks like it produced
  // nothing and there is no way to expand it.
  const hasBody = body.trim().length > 0 || image !== undefined

  return (
    <div className="tool">
      <button className="tool-head" onClick={() => setOpen((value) => !value)} disabled={!hasBody}>
        <span className={`tool-bullet ${running ? 'running' : failed ? 'err' : 'ok'}`}>⏺</span>
        <span className="tool-title">{titleFor(use)}</span>
      </button>

      <div className="tool-summary">
        <span className="elbow">⎿</span>
        <span style={{ color: failed ? 'var(--red)' : undefined }}>
          {running ? 'running…' : (display?.summary ?? (failed ? 'failed' : 'done'))}
        </span>
        {hasBody && (
          <button
            className="icon-btn"
            style={{ padding: '0 4px', fontSize: 10 }}
            onClick={() => setOpen((value) => !value)}
          >
            {open ? 'hide' : 'show'}
          </button>
        )}
      </div>

      {open && hasBody && (
        <div className={`tool-body ${image ? 'tool-body-image' : ''}`}>
          {image ? (
            <img
              className="tool-image"
              src={`data:${image.mediaType};base64,${image.data}`}
              alt={display?.summary ?? ''}
            />
          ) : display?.diff ? (
            renderDiff(display.diff)
          ) : (
            body
          )}
        </div>
      )}
    </div>
  )
}

function renderDiff(diff: string): JSX.Element[] {
  return diff.split('\n').map((line, index) => {
    const className =
      line === '⋮'
        ? 'diff-line diff-gap'
        : line.startsWith('+')
          ? 'diff-line diff-add'
          : line.startsWith('-')
            ? 'diff-line diff-del'
            : 'diff-line'
    return (
      <span key={index} className={className}>
        {line || ' '}
      </span>
    )
  })
}

/** Mirrors the main-process tool titles so the transcript reads consistently. */
function titleFor(use: ToolUseBlock): string {
  const input = use.input as Record<string, string | undefined>
  switch (use.name) {
    case 'read_file':
      return `Read(${input.path ?? ''})`
    case 'write_file':
      return `Write(${input.path ?? ''})`
    case 'edit_file':
      return `Edit(${input.path ?? ''})`
    case 'list_dir':
      return `List(${input.path ?? '.'})`
    case 'glob':
      return `Glob(${input.pattern ?? ''})`
    case 'grep':
      return `Grep(${input.pattern ?? ''})`
    case 'run_command':
      return `Bash(${(input.command ?? '').split('\n')[0].slice(0, 90)})`
    default:
      return `${use.name}(${JSON.stringify(use.input).slice(0, 90)})`
  }
}
