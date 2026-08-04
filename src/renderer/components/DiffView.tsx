type Props = {
  /** Either Forge's own `+`/`-`/`⋮` format or a real unified diff from git. */
  diff: string
  className?: string
}

export default function DiffView({ diff, className }: Props) {
  const lines = diff.split('\n')

  return (
    <div className={className ?? 'code-box'}>
      {lines.map((line, index) => (
        <span key={index} className={classify(line)}>
          {line || ' '}
        </span>
      ))}
    </div>
  )
}

function classify(line: string): string {
  if (line === '⋮') return 'diff-line diff-gap'
  // Unified-diff headers must not be mistaken for additions/removals.
  if (line.startsWith('+++') || line.startsWith('---')) return 'diff-line diff-meta'
  if (line.startsWith('@@')) return 'diff-line diff-hunk'
  if (line.startsWith('diff ') || line.startsWith('index ')) return 'diff-line diff-meta'
  if (line.startsWith('+')) return 'diff-line diff-add'
  if (line.startsWith('-')) return 'diff-line diff-del'
  return 'diff-line'
}
