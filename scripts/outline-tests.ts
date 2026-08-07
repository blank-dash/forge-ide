/**
 * Tests for the symbol outline.
 *
 * Found by pattern rather than by parsing, which is a deliberate trade — a
 * parser per language is a great deal of machinery for a jump list. The risk
 * that buys is false positives: an `if` read as a function, a word inside a
 * comment listed as a declaration. These pin down both directions.
 */
import assert from 'node:assert/strict'
import { findSymbols } from '../src/shared/outline'

/** Names only, which is what the list shows. */
function names(source: string): string[] {
  return findSymbols(source).map((symbol) => symbol.name)
}

export async function runOutlineTests(
  test: (name: string, fn: () => Promise<void> | void) => Promise<void>
): Promise<void> {
  await test('TypeScript declarations are found, exported or not', () => {
    const found = names(
      [
        'export function first() {}',
        'async function second() {}',
        'export default function third() {}',
        'export class Fourth {}',
        'export interface Fifth {}',
        'export type Sixth = string',
        'export const seventh = () => {}',
        'const eighth = async () => {}'
      ].join('\n')
    )

    assert.deepEqual(found, [
      'first',
      'second',
      'third',
      'Fourth',
      'Fifth',
      'Sixth',
      'seventh',
      'eighth'
    ])
  })

  await test('a plain constant is not a symbol', () => {
    // Listing every string in a file would bury the things worth jumping to.
    assert.deepEqual(names("const NAME = 'forge'"), [])
    assert.deepEqual(names('const LIMIT = 42'), [])
  })

  await test('control flow is never mistaken for a declaration', () => {
    const source = [
      '  if (ready) {',
      '  for (const x of y) {',
      '  while (true) {',
      '  } catch (e) {'
    ].join('\n')
    assert.deepEqual(names(source), [])
  })

  await test('comments are skipped', () => {
    const source = ['// function commented() {}', ' * function alsoCommented() {}'].join('\n')
    assert.deepEqual(names(source), [])
  })

  await test('other languages are covered by the same list', () => {
    assert.deepEqual(names('def handler(request):'), ['handler'])
    assert.deepEqual(names('func Serve(w http.ResponseWriter) {'), ['Serve'])
    assert.deepEqual(names('pub async fn run() {'), ['run'])
    assert.deepEqual(names('class Widget:'), ['Widget'])
  })

  await test('markdown headings are the outline of a document', () => {
    const found = findSymbols(['# Title', 'text', '## Section', '### Deeper'].join('\n'))

    assert.deepEqual(
      found.map((symbol) => symbol.name),
      ['Title', 'Section', 'Deeper']
    )
    assert.ok(found.every((symbol) => symbol.kind === 'heading'))
  })

  await test('line numbers are one-based, because that is what editors count in', () => {
    const found = findSymbols(['', '', 'export function third() {}'].join('\n'))

    assert.equal(found.length, 1)
    assert.equal(found[0].line, 3)
  })

  await test('a class method is listed under its own name', () => {
    const source = ['class Thing {', '  doWork(input: string): void {', '  }', '}'].join('\n')
    assert.ok(names(source).includes('doWork'), names(source).join(','))
  })

  await test('an empty file produces an empty outline rather than a failure', () => {
    assert.deepEqual(names(''), [])
    assert.deepEqual(names('\n\n\n'), [])
  })
}
