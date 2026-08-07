import { useState } from 'react'
import type { McpServerConfig, McpServerStatus } from '@shared/types'

type Props = {
  servers: McpServerConfig[]
  statuses: McpServerStatus[]
  onChange(next: McpServerConfig[]): void
}

const PRESETS: Array<{ label: string; config: Omit<McpServerConfig, 'id'> }> = [
  {
    label: 'Filesystem',
    config: {
      name: 'Filesystem',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem', '.'],
      env: {},
      url: '',
      headers: {},
      enabled: true,
      autoApproveTools: []
    }
  },
  {
    label: 'Git',
    config: {
      name: 'Git',
      transport: 'stdio',
      command: 'uvx',
      args: ['mcp-server-git'],
      env: {},
      url: '',
      headers: {},
      enabled: true,
      autoApproveTools: []
    }
  },
  {
    label: 'Remote (HTTP)',
    config: {
      name: 'Remote server',
      transport: 'http',
      command: '',
      args: [],
      env: {},
      url: 'https://example.com/mcp',
      headers: {},
      enabled: true,
      autoApproveTools: []
    }
  }
]

export default function McpSettings({ servers, statuses, onChange }: Props) {
  const [busy, setBusy] = useState<string | null>(null)

  const patch = (index: number, next: McpServerConfig): void =>
    onChange(servers.map((server, i) => (i === index ? next : server)))

  const add = (preset?: Omit<McpServerConfig, 'id'>): void => {
    let n = servers.length + 1
    while (servers.some((server) => server.id === `mcp-${n}`)) n++
    onChange([
      ...servers,
      {
        id: `mcp-${n}`,
        name: `Server ${n}`,
        transport: 'stdio',
        command: '',
        args: [],
        env: {},
        url: '',
        headers: {},
        enabled: true,
        autoApproveTools: [],
        ...preset
      }
    ])
  }

  return (
    <>
      <h3>MCP servers</h3>
      <p>
        Model Context Protocol servers give the agent extra tools — databases, issue trackers,
        browsers, whatever you connect. Save your changes to start or restart them.
      </p>
      <p className="warn-note">
        An MCP server runs as a real process with your permissions, and its tools can act on your
        behalf. Only connect servers you trust, and treat anything they return as data rather than
        as instructions.
      </p>

      {servers.length === 0 && <div className="empty-hint">No servers configured.</div>}

      {servers.map((server, index) => {
        const status = statuses.find((entry) => entry.id === server.id)
        return (
          <div className="provider-card" key={server.id}>
            <div className="provider-head">
              <span className="name">{server.name}</span>
              <span className={`badge ${badgeClass(status)}`}>{status?.state ?? 'stopped'}</span>
              {status?.state === 'ready' && (
                <span className="badge ok">{status.tools.length} tools</span>
              )}
              <span className="meta">
                {server.transport === 'stdio'
                  ? `${server.command} ${server.args.join(' ')}`.trim()
                  : server.url}
              </span>
              <span style={{ flex: 1 }} />
              <label className="switch" onClick={(event) => event.stopPropagation()}>
                <input
                  type="checkbox"
                  checked={server.enabled}
                  onChange={(event) => patch(index, { ...server, enabled: event.target.checked })}
                />
              </label>
            </div>

            <div className="provider-body">
              <div className="row" style={{ marginTop: 12 }}>
                <div className="field">
                  <label>Name</label>
                  <input
                    className="input"
                    value={server.name}
                    onChange={(event) => patch(index, { ...server, name: event.target.value })}
                  />
                </div>
                <div className="field narrow">
                  <label>Transport</label>
                  <select
                    className="select"
                    value={server.transport}
                    onChange={(event) =>
                      patch(index, {
                        ...server,
                        transport: event.target.value as McpServerConfig['transport']
                      })
                    }
                  >
                    <option value="stdio">stdio</option>
                    <option value="http">http</option>
                  </select>
                </div>
              </div>

              {server.transport === 'stdio' ? (
                <>
                  <div className="row">
                    <div className="field">
                      <label>Command</label>
                      <input
                        className="input mono"
                        value={server.command}
                        placeholder="npx"
                        spellCheck={false}
                        onChange={(event) =>
                          patch(index, { ...server, command: event.target.value })
                        }
                      />
                    </div>
                    <div className="field" style={{ flex: 2 }}>
                      <label>Arguments (space separated)</label>
                      <input
                        className="input mono"
                        value={server.args.join(' ')}
                        placeholder="-y @modelcontextprotocol/server-filesystem ."
                        spellCheck={false}
                        onChange={(event) =>
                          patch(index, { ...server, args: splitArgs(event.target.value) })
                        }
                      />
                    </div>
                  </div>

                  <div className="field">
                    <label>Environment (KEY=value per line)</label>
                    <textarea
                      className="textarea mono"
                      style={{ minHeight: 56 }}
                      value={Object.entries(server.env)
                        .map(([key, value]) => `${key}=${value}`)
                        .join('\n')}
                      spellCheck={false}
                      onChange={(event) =>
                        patch(index, { ...server, env: parseEnv(event.target.value) })
                      }
                    />
                  </div>
                </>
              ) : (
                <>
                  <div className="field">
                    <label>URL</label>
                    <input
                      className="input mono"
                      value={server.url}
                      placeholder="https://example.com/mcp"
                      spellCheck={false}
                      onChange={(event) => patch(index, { ...server, url: event.target.value })}
                    />
                  </div>
                  <div className="field">
                    <label>Headers (JSON)</label>
                    <textarea
                      className="textarea mono"
                      style={{ minHeight: 52 }}
                      value={JSON.stringify(server.headers ?? {})}
                      spellCheck={false}
                      onChange={(event) => {
                        try {
                          patch(index, {
                            ...server,
                            headers: JSON.parse(event.target.value || '{}')
                          })
                        } catch {
                          /* keep the last valid object while typing */
                        }
                      }}
                    />
                  </div>
                </>
              )}

              {status?.state === 'error' && (
                <div className="test-result err">{status.error ?? 'Failed to start.'}</div>
              )}

              {status?.state === 'ready' && status.tools.length > 0 && (
                <>
                  <h4>Tools — tick to skip the approval prompt</h4>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                    {status.tools.map((tool) => {
                      const auto = server.autoApproveTools.includes(tool.name)
                      return (
                        <button
                          key={tool.name}
                          className={`pill ${auto ? 'accent' : ''}`}
                          title={tool.description || tool.name}
                          onClick={() =>
                            patch(index, {
                              ...server,
                              autoApproveTools: auto
                                ? server.autoApproveTools.filter((name) => name !== tool.name)
                                : [...server.autoApproveTools, tool.name]
                            })
                          }
                        >
                          {auto ? '✓ ' : ''}
                          {tool.name}
                        </button>
                      )
                    })}
                  </div>
                </>
              )}

              <div className="row" style={{ marginTop: 16 }}>
                <button
                  className="btn"
                  disabled={busy !== null}
                  onClick={async () => {
                    setBusy(server.id)
                    try {
                      await window.forge.mcp.restart(server.id)
                    } finally {
                      setBusy(null)
                    }
                  }}
                >
                  {busy === server.id ? 'Restarting…' : 'Restart'}
                </button>
                <button
                  className="btn btn-danger narrow"
                  onClick={() => onChange(servers.filter((_, i) => i !== index))}
                >
                  Remove
                </button>
                <span style={{ flex: 3 }} />
              </div>
            </div>
          </div>
        )
      })}

      <div className="row" style={{ marginTop: 10 }}>
        <button className="btn" onClick={() => add()}>
          + Add server
        </button>
        {PRESETS.map((preset) => (
          <button key={preset.label} className="btn narrow" onClick={() => add(preset.config)}>
            {preset.label}
          </button>
        ))}
      </div>
    </>
  )
}

function badgeClass(status: McpServerStatus | undefined): string {
  if (status?.state === 'ready') return 'ok'
  if (status?.state === 'error') return 'err'
  return 'off'
}

/** Splits on whitespace but keeps quoted arguments together. */
function splitArgs(value: string): string[] {
  const matches = value.match(/"[^"]*"|'[^']*'|\S+/g) ?? []
  return matches.map((arg) => arg.replace(/^["']|["']$/g, ''))
}

function parseEnv(value: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const line of value.split('\n')) {
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    env[line.slice(0, eq).trim()] = line.slice(eq + 1).trim()
  }
  return env
}
