/**
 * Tests for what gets read aloud.
 *
 * Nothing here can crash, which is exactly why it needs testing: the failure
 * mode is a synthesiser reading a unified diff, character by character, to
 * somebody who then turns the feature off and never turns it back on.
 */
import assert from 'node:assert/strict'
import { forSpeech } from '../src/shared/speech'

export async function runSpeechTests(
  test: (name: string, fn: () => Promise<void> | void) => Promise<void>
): Promise<void> {
  await test('a fenced code block is named, not recited', () => {
    const spoken = forSpeech('Here is the fix:\n\n```ts\nconst x = 1\n```\n\nThat should do it.')

    assert.ok(!spoken.includes('const'))
    assert.ok(!spoken.includes('```'))
    assert.ok(spoken.includes('Here is the fix'))
    assert.ok(spoken.includes('That should do it'))
  })

  await test('two code blocks in one reply are both removed', () => {
    const spoken = forSpeech('One:\n```\nAAA\n```\nTwo:\n```\nBBB\n```\nDone.')

    assert.ok(!spoken.includes('AAA'), spoken)
    assert.ok(!spoken.includes('BBB'), spoken)
    assert.ok(spoken.includes('Done.'))
  })

  await test('inline code keeps its words but loses the backticks', () => {
    // The name of a function is worth hearing; the punctuation around it is not.
    const spoken = forSpeech('Call `readFile` before `editFile`.')

    assert.ok(!spoken.includes('`'))
    assert.ok(spoken.includes('readFile'))
    assert.ok(spoken.includes('editFile'))
  })

  await test('a link is read as its words, never as its address', () => {
    const spoken = forSpeech('See [the release notes](https://example.com/a/very/long/path?x=1).')

    assert.ok(spoken.includes('the release notes'))
    assert.ok(!spoken.includes('example.com'), spoken)
    assert.ok(!spoken.includes('http'))
  })

  await test('an image says nothing at all', () => {
    const spoken = forSpeech('Before: ![a screenshot](data:image/png;base64,AAAA) After')

    assert.ok(!spoken.includes('screenshot'))
    assert.ok(!spoken.includes('base64'))
    assert.equal(spoken, 'Before: After')
  })

  await test('headings, bullets and quotes lose their markers', () => {
    const spoken = forSpeech('## What changed\n\n- first\n- second\n\n> a note\n')

    assert.ok(!spoken.includes('#'))
    assert.ok(!spoken.includes('>'))
    assert.ok(!spoken.startsWith('-'))
    assert.ok(spoken.includes('What changed'))
    assert.ok(spoken.includes('first'))
    assert.ok(spoken.includes('a note'))
  })

  await test('emphasis is dropped without eating the words', () => {
    const spoken = forSpeech('This is **important** and this is *fine*.')

    assert.ok(!spoken.includes('*'))
    assert.ok(spoken.includes('important'))
    assert.ok(spoken.includes('fine'))
  })

  await test('an underscore inside a name is left alone', () => {
    // Stripping every underscore would turn snake_case into two spoken words.
    const spoken = forSpeech('Set max_output_tokens to 4000.')
    assert.ok(spoken.includes('max_output_tokens'), spoken)
  })

  await test('a horizontal rule does not become a row of dashes', () => {
    const spoken = forSpeech('Before\n\n---\n\nAfter')

    assert.ok(!spoken.includes('---'))
    assert.ok(spoken.includes('Before'))
    assert.ok(spoken.includes('After'))
  })

  await test('whitespace collapses so the voice does not pause oddly', () => {
    const spoken = forSpeech('One.\n\n\n\nTwo.   Three.')
    assert.equal(spoken, 'One. Two. Three.')
  })

  await test('a very long reply is cut rather than read for ten minutes', () => {
    const spoken = forSpeech('word '.repeat(5000))
    assert.ok(spoken.length <= 4000)
  })

  await test('nothing to say produces nothing, not whitespace', () => {
    assert.equal(forSpeech(''), '')
    assert.equal(forSpeech('   \n\n  '), '')
    assert.equal(forSpeech('```\nonly code\n```'), '(code)')
  })
}
