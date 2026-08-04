import { useEffect, useState } from 'react'
import type { PermissionDecision, PermissionRequest } from '@shared/types'
import { useStore } from '../store'
import DiffView from './DiffView'

export default function PermissionDialog() {
  const request = useStore((state) => state.permission)
  const setPermission = useStore((state) => state.setPermission)
  const [reason, setReason] = useState('')

  useEffect(() => setReason(''), [request?.id])

  useEffect(() => {
    if (!request) return

    const respond = (decision: PermissionDecision): void => {
      window.forge.agent.respondPermission(request.id, decision)
      useStore.getState().setPermission(null)
    }

    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        respond({ action: 'deny' })
      } else if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
        event.preventDefault()
        respond({ action: 'allow' })
      }
    }

    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [request])

  if (!request) return null

  const respond = (decision: PermissionDecision): void => {
    window.forge.agent.respondPermission(request.id, decision)
    setPermission(null)
  }

  const isDiff = request.kind === 'edit' || request.kind === 'write'

  return (
    <div className="overlay">
      <div className="dialog">
        <div className="dialog-head">
          <h3>{request.title}</h3>
          <p>{subtitle(request)}</p>
        </div>

        <div className="dialog-body">
          {isDiff ? <DiffView diff={request.detail} /> : <div className="code-box">{request.detail}</div>}

          <div className="field" style={{ marginTop: 14, marginBottom: 0 }}>
            <label>Reject with feedback (optional)</label>
            <input
              className="input"
              value={reason}
              placeholder="e.g. use the existing helper in utils.ts instead"
              onChange={(event) => setReason(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && reason.trim()) {
                  event.preventDefault()
                  respond({ action: 'deny', reason })
                }
              }}
            />
          </div>
        </div>

        <div className="dialog-foot">
          <button className="btn btn-primary" onClick={() => respond({ action: 'allow' })}>
            Allow once
          </button>
          <button className="btn" onClick={() => respond({ action: 'allow_always' })}>
            {alwaysLabel(request)}
          </button>
          <button
            className="btn btn-danger"
            onClick={() => respond({ action: 'deny', reason: reason.trim() || undefined })}
          >
            Reject
          </button>
          <span className="kbd-hint">Ctrl+Enter allow · Esc reject</span>
        </div>
      </div>
    </div>
  )
}

function subtitle(request: PermissionRequest): string {
  switch (request.kind) {
    case 'shell':
      return 'The agent wants to run this command in your workspace.'
    case 'external':
      return 'This file is outside the folder you opened. Nothing is read or written until you allow it.'
    case 'mcp':
      return 'An MCP server tool wants to run. It can act outside this app.'
    default:
      return 'The agent wants to apply this change.'
  }
}

function alwaysLabel(request: PermissionRequest): JSX.Element {
  if (request.kind === 'external') {
    return (
      <>
        Always allow this folder <code style={{ opacity: 0.7 }}>{request.suggestedRule}</code>
      </>
    )
  }
  return (
    <>
      Always allow <code style={{ opacity: 0.7 }}>{request.suggestedRule}</code>
    </>
  )
}
