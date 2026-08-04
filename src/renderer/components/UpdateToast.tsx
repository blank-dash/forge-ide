import { useEffect, useState } from 'react'
import type { UpdateStatus } from '../../preload'
import { useStore } from '../store'

/**
 * A quiet corner toast when a new version shows up. Nothing downloads or
 * restarts on its own — swapping the app out from under a running agent turn
 * would be worse than being a day behind.
 */
export default function UpdateToast() {
  const initial = useStore((state) => state.bootstrap?.updates)
  const [status, setStatus] = useState<UpdateStatus | undefined>(initial)
  const [dismissed, setDismissed] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => window.forge.updates.onStatus(setStatus), [])

  if (!status?.supported) return null
  if (status.state !== 'available' && status.state !== 'downloading' && status.state !== 'ready') {
    return null
  }
  if (dismissed === status.version) return null

  const ready = status.state === 'ready'
  const downloading = status.state === 'downloading'

  return (
    <div className="update-toast">
      <span className="update-dot" />

      <div className="update-body">
        <div className="update-title">
          {ready ? `Version ${status.version} is ready` : `Version ${status.version} is available`}
        </div>
        <div className="update-sub">
          {downloading
            ? `Downloading… ${status.percent ?? 0}%`
            : ready
              ? 'Forge will restart to finish installing.'
              : 'Nothing is downloaded until you say so.'}
        </div>
        {downloading && (
          <div className="update-progress">
            <span style={{ width: `${status.percent ?? 0}%` }} />
          </div>
        )}
      </div>

      {!downloading && (
        <button
          className="btn btn-primary"
          disabled={busy}
          onClick={async () => {
            setBusy(true)
            try {
              if (ready) await window.forge.updates.install()
              else await window.forge.updates.download()
            } finally {
              setBusy(false)
            }
          }}
        >
          {ready ? 'Restart' : 'Download'}
        </button>
      )}

      <button
        className="icon-btn"
        title="Later"
        onClick={() => setDismissed(status.version ?? 'unknown')}
      >
        ×
      </button>
    </div>
  )
}
