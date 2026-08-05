/**
 * Tests for the picker's ranking.
 *
 * A fuzzy finder that merely filters is easy; one that puts the file you meant
 * at the top is not, and the difference is the whole feature. These lock down
 * the orderings people actually expect rather than the ones that happen to fall
 * out of the arithmetic.
 */
import assert from 'node:assert/strict'
import { fuzzyMatch, fuzzyRank } from '../src/shared/fuzzy'

/** Which candidate the picker would put first. */
function best(query: string, candidates: string[]): string {
  const ranked = fuzzyRank(query, candidates, (entry) => entry)
  return ranked[0]?.item ?? ''
}

export async function runFuzzyTests(
  test: (name: string, fn: () => Promise<void> | void) => Promise<void>
): Promise<void> {
  await test('a query must appear in order, not merely in the letters', () => {
    assert.ok(fuzzyMatch('abc', 'a-b-c').score > 0)
    assert.equal(fuzzyMatch('cba', 'a-b-c').score, 0, 'out-of-order letters are not a match')
    assert.equal(fuzzyMatch('abcd', 'a-b-c').score, 0, 'a missing letter is not a match')
  })

  await test('an empty query matches everything, so the list starts unfiltered', () => {
    assert.ok(fuzzyMatch('', 'anything').score > 0)
    assert.equal(fuzzyRank('', ['a', 'b', 'c'], (entry) => entry).length, 3)
  })

  await test('initials beat letters scattered through the middle', () => {
    // The initials of a filename are what someone typing initials means. Note
    // the trap: `src` also begins with c-in-position, so a scan that simply
    // takes the first occurrence of each letter misses this entirely.
    assert.equal(
      best('cts', ['docs/contacts.md', 'src/components/ChatToolStrip.tsx']),
      'src/components/ChatToolStrip.tsx'
    )
  })

  await test('camel humps count as word starts', () => {
    assert.equal(best('cm', ['ChatMessage.tsx', 'chmod-notes.md']), 'ChatMessage.tsx')
  })

  await test('a match at the start beats the same match buried deeper', () => {
    assert.equal(best('app', ['app.tsx', 'src/very/deep/place/snapp.tsx']), 'app.tsx')
  })

  await test('the filename wins over a directory that happens to contain the letters', () => {
    assert.equal(
      best('store', ['src/store/index.ts', 'src/renderer/store.ts']),
      'src/renderer/store.ts'
    )
  })

  await test('consecutive letters beat the same letters spread out', () => {
    const together = fuzzyMatch('test', 'test-runner.ts').score
    const apart = fuzzyMatch('test', 'the-early-set-tool.ts').score
    assert.ok(together > apart, `${together} should beat ${apart}`)
  })

  await test('a shorter candidate wins a tie', () => {
    assert.equal(best('index', ['index.ts', 'index-of-everything-here.ts']), 'index.ts')
  })

  await test('exact case is preferred but never required', () => {
    assert.ok(fuzzyMatch('CM', 'ChatMessage').score > fuzzyMatch('cm', 'ChatMessage').score)
    assert.ok(fuzzyMatch('cm', 'ChatMessage').score > 0, 'lowercase must still match')
  })

  await test('positions come back so the match can be highlighted', () => {
    const match = fuzzyMatch('cm', 'ChatMessage')

    assert.deepEqual(match.positions, [0, 4])
    assert.equal('ChatMessage'[0], 'C')
    assert.equal('ChatMessage'[4], 'M')
  })

  await test('ranking drops what does not match and keeps the rest ordered', () => {
    const ranked = fuzzyRank('ts', ['a.ts', 'nope.md', 'b.ts'], (entry) => entry)

    assert.equal(ranked.length, 2)
    assert.ok(ranked.every((entry) => entry.item.endsWith('.ts')))
  })

  await test('the result list is capped so a huge repository stays responsive', () => {
    const many = Array.from({ length: 5000 }, (_, index) => `file-${index}.ts`)
    assert.equal(fuzzyRank('file', many, (entry) => entry, 20).length, 20)
  })

  await test('equal scores keep the order they were given', () => {
    // Otherwise an unfiltered picker reshuffles itself between keystrokes.
    const items = ['aaa.ts', 'bbb.ts', 'ccc.ts']
    assert.deepEqual(
      fuzzyRank('', items, (entry) => entry).map((entry) => entry.item),
      items
    )
  })
}
