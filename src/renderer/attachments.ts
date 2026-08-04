/**
 * Turning clipboard and drag-drop payloads into things the agent can use.
 *
 * Three shapes come out of a paste: pixels with no path (a screenshot), files
 * that exist on disk, and text. They want different treatment — an image has
 * to be encoded into the request, a file is better referenced by path so the
 * agent can read as much or as little of it as it needs, and a very long text
 * paste should not swamp the composer.
 */

export type Attachment =
  | {
      kind: 'image'
      id: string
      name: string
      mediaType: string
      /** Base64 without the data: prefix. */
      data: string
      /** Object URL for the thumbnail; revoked when the attachment is dropped. */
      preview: string
      bytes: number
    }
  | { kind: 'file'; id: string; name: string; path: string; bytes: number }
  | { kind: 'text'; id: string; name: string; text: string; lines: number }

/** Anthropic downsamples anything larger, so sending more is wasted upload. */
const MAX_IMAGE_EDGE = 1568
const MAX_IMAGE_BYTES = 4 * 1024 * 1024
/** A paste longer than this becomes a chip instead of filling the composer. */
export const LARGE_PASTE_LINES = 24
export const LARGE_PASTE_CHARS = 2_000

let counter = 0
const nextId = (): string => `att-${Date.now()}-${counter++}`

const IMAGE_EXTENSIONS = /\.(png|jpe?g|gif|webp|avif|bmp|svg|ico|heic|heif)$/i

/**
 * Dragging a file out of Explorer often arrives with an empty `type`, so a
 * screenshot would land as a generic file chip instead of a thumbnail. The
 * extension is the reliable signal on Windows.
 */
export function isImage(file: File): boolean {
  return file.type.startsWith('image/') || IMAGE_EXTENSIONS.test(file.name)
}

/**
 * Re-encodes an image down to a sane size. Screenshots are frequently 4K PNGs
 * that cost a fortune in tokens and get downscaled server-side anyway.
 */
export async function toImageAttachment(file: File): Promise<Attachment> {
  const bitmap = await createImageBitmap(file).catch(() => null)

  if (!bitmap) {
    // Not decodable as an image after all — fall back to the raw bytes.
    const data = await toBase64(file)
    return {
      kind: 'image',
      id: nextId(),
      name: file.name || 'image',
      mediaType: file.type || mediaTypeFor(file.name),
      data,
      preview: URL.createObjectURL(file),
      bytes: file.size
    }
  }

  const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(bitmap.width, bitmap.height))
  const width = Math.max(1, Math.round(bitmap.width * scale))
  const height = Math.max(1, Math.round(bitmap.height * scale))

  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  canvas.getContext('2d')?.drawImage(bitmap, 0, 0, width, height)
  bitmap.close()

  // PNG keeps screenshots and diagrams crisp; JPEG would blur text.
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, 'image/png')
  )
  const source = blob && blob.size < file.size ? blob : file

  return {
    kind: 'image',
    id: nextId(),
    name: file.name || 'pasted image',
    mediaType: source === file ? file.type || mediaTypeFor(file.name) : 'image/png',
    data: await toBase64(source),
    preview: URL.createObjectURL(source),
    bytes: source.size
  }
}

/** Providers reject an image block whose media type does not match the bytes. */
function mediaTypeFor(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase() ?? ''
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg'
  if (ext === 'gif') return 'image/gif'
  if (ext === 'webp') return 'image/webp'
  return 'image/png'
}

export function toFileAttachment(file: File, path: string): Attachment {
  return {
    kind: 'file',
    id: nextId(),
    name: file.name || path.split(/[\\/]/).pop() || 'file',
    path,
    bytes: file.size
  }
}

export function toTextAttachment(text: string): Attachment {
  const lines = text.split('\n').length
  return {
    kind: 'text',
    id: nextId(),
    name: `Pasted text · ${lines} lines`,
    text,
    lines
  }
}

export function isLargePaste(text: string): boolean {
  return text.split('\n').length > LARGE_PASTE_LINES || text.length > LARGE_PASTE_CHARS
}

export function tooLarge(attachment: Attachment): boolean {
  return attachment.kind === 'image' && attachment.bytes > MAX_IMAGE_BYTES
}

export function releaseAttachment(attachment: Attachment): void {
  if (attachment.kind === 'image') URL.revokeObjectURL(attachment.preview)
}

/**
 * Folds attachments into what actually gets sent: file paths and long pastes
 * become part of the prompt, images travel as image blocks.
 */
export function composeMessage(
  text: string,
  attachments: Attachment[]
): { text: string; images: Array<{ mediaType: string; data: string }> } {
  const files = attachments.filter((entry) => entry.kind === 'file')
  const texts = attachments.filter((entry) => entry.kind === 'text')
  const images = attachments.filter((entry) => entry.kind === 'image')

  const parts: string[] = []

  if (files.length > 0) {
    parts.push(
      files.length === 1
        ? `Attached file: ${(files[0] as { path: string }).path}`
        : `Attached files:\n${files
            .map((entry) => `  ${(entry as { path: string }).path}`)
            .join('\n')}`
    )
  }

  if (text.trim()) parts.push(text.trim())

  for (const entry of texts) {
    const block = entry as { text: string }
    parts.push(`Pasted text:\n\`\`\`\n${block.text}\n\`\`\``)
  }

  return {
    text: parts.join('\n\n'),
    images: images.map((entry) => {
      const image = entry as { mediaType: string; data: string }
      return { mediaType: image.mediaType, data: image.data }
    })
  }
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function toBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new Error('Could not read the file.'))
    reader.onload = () => {
      const result = String(reader.result)
      // Strip the `data:<type>;base64,` prefix the API does not want.
      resolve(result.slice(result.indexOf(',') + 1))
    }
    reader.readAsDataURL(blob)
  })
}
