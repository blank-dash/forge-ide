/**
 * Small line-level diff used to render edits before the user approves them.
 * Not a full Myers implementation — an LCS table is plenty for the file sizes
 * an edit touches, and it keeps the app dependency-free.
 */

export interface DiffLine {
  kind: 'add' | 'del' | 'ctx'
  text: string
}

const MAX_LCS_CELLS = 4_000_000

export function diffLines(before: string, after: string): DiffLine[] {
  const a = before.split('\n')
  const b = after.split('\n')

  // Trim the common prefix/suffix first: edits are usually local, so this
  // keeps the LCS table tiny even for large files.
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++

  let endA = a.length
  let endB = b.length
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--
    endB--
  }

  const midA = a.slice(start, endA)
  const midB = b.slice(start, endB)

  const out: DiffLine[] = []
  for (let i = 0; i < start; i++) out.push({ kind: 'ctx', text: a[i] })

  if (midA.length * midB.length > MAX_LCS_CELLS) {
    // Degrade gracefully rather than allocating gigabytes.
    for (const text of midA) out.push({ kind: 'del', text })
    for (const text of midB) out.push({ kind: 'add', text })
  } else {
    out.push(...lcsDiff(midA, midB))
  }

  for (let i = endA; i < a.length; i++) out.push({ kind: 'ctx', text: a[i] })
  return out
}

function lcsDiff(a: string[], b: string[]): DiffLine[] {
  const rows = a.length + 1
  const cols = b.length + 1
  const table = new Uint32Array(rows * cols)

  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i * cols + j] =
        a[i] === b[j]
          ? table[(i + 1) * cols + j + 1] + 1
          : Math.max(table[(i + 1) * cols + j], table[i * cols + j + 1])
    }
  }

  const out: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ kind: 'ctx', text: a[i] })
      i++
      j++
    } else if (table[(i + 1) * cols + j] >= table[i * cols + j + 1]) {
      out.push({ kind: 'del', text: a[i] })
      i++
    } else {
      out.push({ kind: 'add', text: b[j] })
      j++
    }
  }
  while (i < a.length) out.push({ kind: 'del', text: a[i++] })
  while (j < b.length) out.push({ kind: 'add', text: b[j++] })
  return out
}

/**
 * Renders a compact diff with `context` unchanged lines around each hunk,
 * in the `+`/`-`/space format the chat panel colourises.
 */
export function renderDiff(before: string, after: string, context = 3): string {
  const lines = diffLines(before, after)
  const keep = new Set<number>()

  lines.forEach((line, index) => {
    if (line.kind === 'ctx') return
    for (let i = index - context; i <= index + context; i++) {
      if (i >= 0 && i < lines.length) keep.add(i)
    }
  })

  if (keep.size === 0) return ''

  const out: string[] = []
  let lastKept = -1
  for (let i = 0; i < lines.length; i++) {
    if (!keep.has(i)) continue
    if (lastKept !== -1 && i - lastKept > 1) out.push('⋮')
    const line = lines[i]
    out.push(`${line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ' '}${line.text}`)
    lastKept = i
  }
  return out.join('\n')
}

export function countChanges(before: string, after: string): { added: number; removed: number } {
  let added = 0
  let removed = 0
  for (const line of diffLines(before, after)) {
    if (line.kind === 'add') added++
    else if (line.kind === 'del') removed++
  }
  return { added, removed }
}
