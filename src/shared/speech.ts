/**
 * Preparing text to be read aloud.
 *
 * Kept apart from the renderer's audio plumbing so it can be tested without a
 * browser — and it is the part most worth testing, because getting it wrong is
 * not a crash but a synthesiser patiently reading a diff out loud, which is the
 * fastest way to make someone switch the feature off for good.
 */

const MAX_SPOKEN_CHARS = 4000

export function forSpeech(markdown: string): string {
  return (
    markdown
      // Fenced code first, or the inline rule below would chew through its
      // contents and leave the fences behind.
      .replace(/```[\s\S]*?```/g, ' (code) ')
      .replace(/~~~[\s\S]*?~~~/g, ' (code) ')
      .replace(/`([^`]*)`/g, '$1')
      // An image is nothing to say; a link is worth saying the words of, but
      // never the URL.
      .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/^\s{0,3}#{1,6}\s+/gm, '')
      .replace(/^\s{0,3}[-*+]\s+/gm, '')
      .replace(/^\s{0,3}>\s?/gm, '')
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/(^|\W)[*_]([^*_]+)[*_](?=\W|$)/g, '$1$2')
      .replace(/^\s*[-*_]{3,}\s*$/gm, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, MAX_SPOKEN_CHARS)
  )
}
