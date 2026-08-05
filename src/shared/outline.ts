/**
 * Symbols in a file, found by pattern rather than by parsing.
 *
 * A parser per language is a great deal of machinery for a jump list, and a set
 * of patterns that knows what a declaration looks like in the shapes these
 * languages share does the same job. It is allowed to miss one — the file is
 * right there — but it must not invent one, so control flow and comments are
 * excluded explicitly.
 *
 * Pure, so it can be tested without a window.
 */

export interface CodeSymbol {
  name: string
  kind: string
  line: number
}

const SYMBOL_PATTERNS: Array<{ kind: string; pattern: RegExp }> = [
  { kind: 'class', pattern: /^\s*(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/ },
  {
    kind: 'function',
    pattern: /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/
  },
  { kind: 'interface', pattern: /^\s*(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/ },
  { kind: 'type', pattern: /^\s*(?:export\s+)?type\s+([A-Za-z_$][\w$]*)/ },
  {
    kind: 'const',
    pattern: /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*[:=]\s*(?:async\s*)?(?:\(|function|<)/
  },
  { kind: 'def', pattern: /^\s*def\s+([A-Za-z_][\w]*)/ },
  { kind: 'class', pattern: /^\s*class\s+([A-Za-z_][\w]*)/ },
  { kind: 'func', pattern: /^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_][\w]*)/ },
  { kind: 'fn', pattern: /^\s*(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z_][\w]*)/ },
  { kind: 'method', pattern: /^\s{2,}(?:public|private|protected|static|async|\s)*([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*[:{]/ },
  { kind: 'heading', pattern: /^(#{1,6})\s+(.+)$/ }
]

export function findSymbols(source: string): CodeSymbol[] {
  const found: CodeSymbol[] = []
  const lines = source.split('\n')

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]
    if (!line.trim() || line.trim().startsWith('//') || line.trim().startsWith('*')) continue

    for (const { kind, pattern } of SYMBOL_PATTERNS) {
      const match = pattern.exec(line)
      if (!match) continue

      // Markdown headings carry their level in the first group and the text in
      // the second; everything else names itself in the first.
      const name = kind === 'heading' ? match[2].trim() : match[1]
      if (!name || RESERVED.has(name)) break

      found.push({ name, kind, line: index + 1 })
      break
    }
  }

  return found
}

/** Words that look like a declaration to the patterns but never are. */
const RESERVED = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'else', 'do', 'try'])
