/**
 * Minimal Server-Sent Events reader.
 *
 * Every provider we talk to streams SSE, but they disagree on whether they
 * send an `event:` line, so we surface both the event name and the data
 * payload and let each adapter decide what it cares about.
 */
export interface SseMessage {
  event: string
  data: string
}

export async function* readSse(body: ReadableStream<Uint8Array>): AsyncGenerator<SseMessage> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })

      // Frames are separated by a blank line. Tolerate \r\n from proxies.
      let sep = findSeparator(buffer)
      while (sep !== -1) {
        const raw = buffer.slice(0, sep.index)
        buffer = buffer.slice(sep.index + sep.length)
        const frame = parseFrame(raw)
        if (frame) yield frame
        sep = findSeparator(buffer)
      }
    }

    const tail = parseFrame(buffer)
    if (tail) yield tail
  } finally {
    reader.releaseLock()
  }
}

function findSeparator(buffer: string): { index: number; length: number } | -1 {
  const lf = buffer.indexOf('\n\n')
  const crlf = buffer.indexOf('\r\n\r\n')
  if (lf === -1 && crlf === -1) return -1
  if (crlf !== -1 && (lf === -1 || crlf < lf)) return { index: crlf, length: 4 }
  return { index: lf, length: 2 }
}

function parseFrame(raw: string): SseMessage | null {
  if (!raw.trim()) return null

  let event = 'message'
  const dataLines: string[] = []

  for (const line of raw.split(/\r?\n/)) {
    if (!line || line.startsWith(':')) continue
    const colon = line.indexOf(':')
    const field = colon === -1 ? line : line.slice(0, colon)
    // A single leading space after the colon is part of the protocol.
    const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '')

    if (field === 'event') event = value
    else if (field === 'data') dataLines.push(value)
  }

  if (dataLines.length === 0) return null
  return { event, data: dataLines.join('\n') }
}

/** JSON.parse that never throws — malformed keep-alive frames are common. */
export function safeParse<T>(text: string): T | null {
  try {
    return JSON.parse(text) as T
  } catch {
    return null
  }
}
