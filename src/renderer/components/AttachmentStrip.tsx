import { useState } from 'react'
import { formatBytes, tooLarge, type Attachment } from '../attachments'

type Props = {
  attachments: Attachment[]
  /** False when the active model cannot see images. */
  visionSupported: boolean
  onRemove(id: string): void
}

export default function AttachmentStrip({ attachments, visionSupported, onRemove }: Props) {
  const [preview, setPreview] = useState<Attachment | null>(null)

  if (attachments.length === 0) return null

  const blockedImages = attachments.some((entry) => entry.kind === 'image') && !visionSupported

  return (
    <>
      <div className="attach-strip">
        {attachments.map((attachment) => (
          <div
            key={attachment.id}
            className={`attach-chip ${tooLarge(attachment) ? 'bad' : ''}`}
            title={describe(attachment)}
          >
            {attachment.kind === 'image' ? (
              <button className="attach-thumb" onClick={() => setPreview(attachment)}>
                <img src={attachment.preview} alt={attachment.name} />
              </button>
            ) : (
              <span className="attach-icon">{attachment.kind === 'file' ? '📄' : '¶'}</span>
            )}

            <span className="attach-meta">
              <span className="attach-name">{attachment.name}</span>
              <span className="attach-sub">{subtitle(attachment)}</span>
            </span>

            <button
              className="icon-btn danger"
              onClick={() => onRemove(attachment.id)}
              title="Remove"
            >
              ×
            </button>
          </div>
        ))}
      </div>

      {blockedImages && (
        <div className="attach-warning">
          The selected model is not marked as vision-capable, so images will be dropped. Tick
          “vision” for it in Settings → Providers, or pick another model.
        </div>
      )}

      {preview?.kind === 'image' && (
        <div className="overlay" onClick={() => setPreview(null)}>
          <img className="attach-lightbox" src={preview.preview} alt={preview.name} />
        </div>
      )}
    </>
  )
}

function subtitle(attachment: Attachment): string {
  switch (attachment.kind) {
    case 'image':
      return tooLarge(attachment)
        ? `${formatBytes(attachment.bytes)} — too large`
        : formatBytes(attachment.bytes)
    case 'file':
      return formatBytes(attachment.bytes)
    case 'text':
      return `${attachment.text.length.toLocaleString()} chars`
  }
}

function describe(attachment: Attachment): string {
  switch (attachment.kind) {
    case 'file':
      return attachment.path
    case 'image':
      return `${attachment.name} · sent with the message`
    case 'text':
      return attachment.text.slice(0, 400)
  }
}
