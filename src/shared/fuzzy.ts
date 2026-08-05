/**
 * Fuzzy matching for the pickers.
 *
 * The behaviour people expect from a quick-open box is specific and easy to get
 * wrong: typing "cts" should find `components/ChatToolStrip.tsx`, because those
 * letters begin words, and typing "store" should find `renderer/store.ts` ahead
 * of `store/index.ts`, because the file is the thing being named. So this scores
 * rather than merely filters, and the scoring rules are the whole feature.
 *
 * Pure, so it can be tested without a window.
 */

export interface FuzzyMatch {
  /** Higher is better. Zero means no match at all. */
  score: number
  /** Indices in the candidate that were matched, for highlighting. */
  positions: number[]
}

/** Weights chosen so the ordering reads the way people expect. */
const BONUS_START = 12
const BONUS_BOUNDARY = 9
const BONUS_CAMEL = 7
const BONUS_CONSECUTIVE = 6
const BONUS_EXACT_CASE = 1
/** Matching inside the filename rather than across the path. */
const BONUS_BASENAME = 10
/** Every letter landing on the start of a word, i.e. genuine initials. */
const BONUS_INITIALS = 14
const PENALTY_GAP = 1
const MAX_GAP_PENALTY = 6
const PENALTY_LEADING = 2
const MAX_LEADING_PENALTY = 12

/**
 * Matches `query` against `candidate`, in order but not contiguously.
 *
 * Returns a score of 0 when a character cannot be found — the query is a
 * subsequence of the candidate, or it is not a match at all.
 */
export function fuzzyMatch(query: string, candidate: string): FuzzyMatch {
  const needle = query.trim()
  if (!needle) return { score: 1, positions: [] }
  if (!candidate) return { score: 0, positions: [] }

  const whole = matchFrom(needle, candidate, 0)

  /*
   * Tried again against the filename alone.
   *
   * The scan takes the first occurrence of each letter, which for a path means
   * "cts" finds the c in `src` and then has to reach forward for the rest —
   * scoring a real match as if it were a coincidence. Restricting the second
   * attempt to the part after the last separator is what lets the initials of a
   * filename win, which is what someone typing initials meant.
   */
  const cut = basenameStart(candidate)
  if (cut === 0) return whole

  const candidates: FuzzyMatch[] = [whole]

  const base = matchFrom(needle, candidate, cut)
  if (base.score > 0) candidates.push({ score: base.score + BONUS_BASENAME, positions: base.positions })

  /*
   * A pass that will only land on word starts.
   *
   * The ordinary scan takes the first occurrence of each letter, so "cts"
   * against `ChatToolStrip` matches the t of Chat rather than the T of Tool and
   * scores a deliberate set of initials as if it were an accident. This pass
   * either matches every letter at the beginning of a word or fails outright,
   * which makes it exactly the signal it is meant to be.
   */
  const initials = matchFrom(needle, candidate, cut, true)
  if (initials.score > 0) {
    candidates.push({
      score: initials.score + BONUS_BASENAME + BONUS_INITIALS,
      positions: initials.positions
    })
  }

  return candidates.reduce((best, entry) => (entry.score > best.score ? entry : best))
}

/** Ranks candidates, dropping the ones that do not match at all. */
export function fuzzyRank<T>(
  query: string,
  items: T[],
  key: (item: T) => string,
  limit = 50
): Array<{ item: T; match: FuzzyMatch }> {
  const scored: Array<{ item: T; match: FuzzyMatch; index: number }> = []

  items.forEach((item, index) => {
    const match = fuzzyMatch(query, key(item))
    if (match.score > 0) scored.push({ item, match, index })
  })

  // Ties keep their original order, so an unfiltered list does not reshuffle
  // itself between keystrokes.
  return scored
    .sort((a, b) => b.match.score - a.match.score || a.index - b.index)
    .slice(0, limit)
    .map(({ item, match }) => ({ item, match }))
}

/* ------------------------------------------------------------------ */

/**
 * One left-to-right pass, starting the search at `from`.
 *
 * With `boundariesOnly`, a letter counts only where a word begins.
 */
function matchFrom(
  needle: string,
  candidate: string,
  from: number,
  boundariesOnly = false
): FuzzyMatch {
  const lowerNeedle = needle.toLowerCase()
  const lowerHay = candidate.toLowerCase()

  const positions: number[] = []
  let score = 0
  let at = from
  let previous = -1

  for (let index = 0; index < lowerNeedle.length; index++) {
    const found = boundariesOnly
      ? nextBoundary(candidate, lowerHay, lowerNeedle[index], at)
      : lowerHay.indexOf(lowerNeedle[index], at)
    if (found === -1) return { score: 0, positions: [] }

    score += bonusAt(candidate, found)
    if (candidate[found] === needle[index]) score += BONUS_EXACT_CASE

    if (found === previous + 1) score += BONUS_CONSECUTIVE
    else if (previous !== -1) score -= Math.min(PENALTY_GAP * (found - previous - 1), MAX_GAP_PENALTY)

    positions.push(found)
    previous = found
    at = found + 1
  }

  // A match that starts late is usually the wrong candidate: "app" should
  // prefer `app.tsx` over `src/components/very/deep/snap.tsx`.
  score -= Math.min((positions[0] - from) * PENALTY_LEADING, MAX_LEADING_PENALTY)

  // Shorter candidates win ties, so an exact filename beats a longer path that
  // happens to contain the same letters.
  score += Math.max(0, 20 - candidate.length / 4)

  return { score: Math.max(1, Math.round(score)), positions }
}

/** The next place this letter begins a word, or -1. */
function nextBoundary(candidate: string, lowerHay: string, letter: string, from: number): number {
  for (let index = lowerHay.indexOf(letter, from); index !== -1; index = lowerHay.indexOf(letter, index + 1)) {
    if (bonusAt(candidate, index) > 0) return index
  }
  return -1
}

function basenameStart(candidate: string): number {
  const slash = Math.max(candidate.lastIndexOf('/'), candidate.lastIndexOf('\\'))
  return slash + 1
}

function bonusAt(candidate: string, index: number): number {
  if (index === 0) return BONUS_START

  const previous = candidate[index - 1]
  const current = candidate[index]

  // A separator means the next character starts a word, which is usually what
  // someone typing initials is aiming at.
  if (previous === '/' || previous === '\\' || previous === '.') return BONUS_START
  if (previous === '-' || previous === '_' || previous === ' ') return BONUS_BOUNDARY

  // camelCase humps read as word starts too.
  if (previous === previous.toLowerCase() && current === current.toUpperCase()) {
    return BONUS_CAMEL
  }
  return 0
}
