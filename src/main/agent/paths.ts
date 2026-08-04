import { promises as fs } from 'node:fs'
import path from 'node:path'

/**
 * Absolute paths as people actually type them: `C:\Users\me\notes.md`,
 * `C:/Users/me/notes.md`, `\\server\share\file`, `/home/me/notes.md`.
 * Trailing punctuation is stripped afterwards so "look at /tmp/a.txt." works.
 */
const PATTERNS = [
  /[A-Za-z]:[\\/][^\s"'<>|?*]+/g,
  /\\\\[^\s"'<>|?*]+/g,
  /(?:^|[\s"'`(])(\/[^\s"'<>|?*`)]+)/g
]

const TRAILING = /[.,;:!?)\]}"'`]+$/

/**
 * Extracts paths the user named and keeps the ones that exist.
 *
 * Naming a path is the authorisation: a user who writes "fix C:\proj\a.ts" has
 * already decided the agent may touch it, and making them click through a
 * dialog for the file they just asked about is friction with no safety value.
 * Paths that do not exist are ignored — they are far more likely to be prose
 * than a grant.
 */
export async function findMentionedPaths(text: string, limit = 12): Promise<string[]> {
  const candidates = new Set<string>()

  for (const pattern of PATTERNS) {
    // `lastIndex` persists on a global regex reused across calls.
    pattern.lastIndex = 0
    let match = pattern.exec(text)
    while (match !== null && candidates.size < limit * 4) {
      const raw = (match[1] ?? match[0]).replace(TRAILING, '')
      if (raw.length > 3) candidates.add(path.normalize(raw))
      match = pattern.exec(text)
    }
  }

  // Grant exactly what was named — the file itself, or the directory if that is
  // what the user pointed at. Never the parent of a named file.
  const checked = await Promise.all(
    [...candidates].slice(0, limit * 4).map(async (candidate) => {
      const exists = await fs.stat(candidate).then(() => true, () => false)
      return exists ? candidate : null
    })
  )

  return checked.filter((entry): entry is string => entry !== null).slice(0, limit)
}
