import { BRAND_ACCENT } from '@shared/brand'
import { useEffect, useRef, useState } from 'react'
import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import { useStore } from '../store'

let nextKey = 1

export default function TerminalPane() {
  const [tabs, setTabs] = useState<number[]>([1])
  const [active, setActive] = useState(1)
  const patchUi = useStore((state) => state.patchUi)

  const add = (): void => {
    const key = ++nextKey
    setTabs((current) => [...current, key])
    setActive(key)
  }

  const close = (key: number): void => {
    setTabs((current) => {
      const next = current.filter((entry) => entry !== key)
      if (next.length === 0) {
        patchUi({ terminalOpen: false })
        return current
      }
      setActive((currentActive) => (currentActive === key ? next[next.length - 1] : currentActive))
      return next
    })
  }

  return (
    <>
      <div className="pane-header">
        <div className="term-tabs">
          {tabs.map((key, index) => (
            <button
              key={key}
              className={`term-tab ${active === key ? 'active' : ''}`}
              onClick={() => setActive(key)}
            >
              shell {index + 1}
              <span
                className="close"
                role="button"
                onClick={(event) => {
                  event.stopPropagation()
                  close(key)
                }}
              >
                ×
              </span>
            </button>
          ))}
          <button className="icon-btn" onClick={add} title="New terminal">
            +
          </button>
        </div>
        <span style={{ flex: 1 }} />
        <button
          className="icon-btn"
          onClick={() => patchUi({ terminalOpen: false })}
          title="Close panel (Ctrl+`)"
        >
          ×
        </button>
      </div>

      <div className="terminal-stack">
        {tabs.map((key) => (
          <TerminalInstance key={key} visible={active === key} />
        ))}
      </div>
    </>
  )
}

type InstanceProps = {
  visible: boolean
}

function TerminalInstance({ visible }: InstanceProps) {
  const host = useRef<HTMLDivElement>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const theme = useStore((state) => state.settings.theme)
  const fontFamily = useStore((state) => state.settings.fontFamily)

  useEffect(() => {
    const element = host.current
    if (!element) return

    const term = new Terminal({
      fontFamily,
      fontSize: 12.5,
      lineHeight: 1.3,
      cursorBlink: true,
      allowProposedApi: true,
      scrollback: 5000,
      theme: theme === 'light' ? LIGHT_THEME : DARK_THEME
    })

    const fit = new FitAddon()
    fitRef.current = fit
    term.loadAddon(fit)
    term.open(element)
    safeFit(fit)

    let sessionId: string | null = null
    let disposed = false

    const offData = window.forge.terminal.onData(({ id, data }) => {
      if (id === sessionId) term.write(data)
    })

    void window.forge.terminal
      .create(term.cols, term.rows)
      .then((handle) => {
        if (disposed) {
          void window.forge.terminal.kill(handle.id)
          return
        }
        sessionId = handle.id

        if (handle.backend === 'pipe') {
          term.writeln(
            '\x1b[38;5;179mRunning without a pty — no prompt, and interactive programs will ' +
              'not work.\x1b[0m'
          )
          if (handle.degradedReason) {
            term.writeln(`\x1b[38;5;244m${handle.degradedReason}\x1b[0m`)
          }
          // Nothing echoes our input back, so draw it ourselves.
          attachLocalEcho(term, () => sessionId)
        } else {
          // A real pty echoes and prompts; forward keystrokes untouched.
          term.onData((data) => {
            if (sessionId) window.forge.terminal.write(sessionId, data)
          })
        }
      })
      .catch((error: Error) => term.writeln(`\r\nFailed to start a shell: ${error.message}`))

    const observer = new ResizeObserver(() => {
      safeFit(fit)
      if (sessionId) window.forge.terminal.resize(sessionId, term.cols, term.rows)
    })
    observer.observe(element)

    return () => {
      disposed = true
      observer.disconnect()
      offData()
      if (sessionId) void window.forge.terminal.kill(sessionId)
      term.dispose()
      fitRef.current = null
    }
  }, [theme, fontFamily])

  // A hidden terminal has no size; refit the moment it comes back.
  useEffect(() => {
    if (!visible) return
    const timer = setTimeout(() => safeFit(fitRef.current), 20)
    return () => clearTimeout(timer)
  }, [visible])

  return (
    <div className="terminal-host" ref={host} style={{ display: visible ? 'block' : 'none' }} />
  )
}

function safeFit(fit: FitAddon | null): void {
  try {
    fit?.fit()
  } catch {
    // The element can be detached or zero-sized mid-transition.
  }
}

const BACKSPACE = String.fromCharCode(127)
const CTRL_C = String.fromCharCode(3)

/** Line editing for the pipe fallback, where the shell echoes nothing. */
function attachLocalEcho(term: Terminal, sessionId: () => string | null): void {
  let line = ''
  const prompt = (): void => term.write('\x1b[38;2;217;119;87m❯\x1b[0m ')
  prompt()

  term.onData((data) => {
    const id = sessionId()
    if (!id) return

    for (const char of data) {
      if (char === '\r') {
        term.write('\r\n')
        window.forge.terminal.write(id, `${line}\n`)
        line = ''
      } else if (char === BACKSPACE || char === '\b') {
        if (line.length > 0) {
          line = line.slice(0, -1)
          term.write('\b \b')
        }
      } else if (char === CTRL_C) {
        term.write('^C\r\n')
        line = ''
        prompt()
      } else if (char >= ' ') {
        line += char
        term.write(char)
      }
    }
  })
}

const DARK_THEME = {
  background: '#100f0e',
  foreground: '#ededeb',
  cursor: BRAND_ACCENT,
  cursorAccent: '#100f0e',
  selectionBackground: '#2c2c28',
  black: '#232320',
  red: '#d05a5a',
  green: '#7fb069',
  yellow: '#d4a24e',
  blue: '#6a9fdc',
  magenta: '#a98fd0',
  cyan: '#5fb3b3',
  white: '#b4b1a9',
  brightBlack: '#5d5a55',
  brightRed: '#e07070',
  brightGreen: '#95c47f',
  brightYellow: '#e5b869',
  brightBlue: '#84b4e8',
  brightMagenta: '#bda6de',
  brightCyan: '#7ac7c7',
  brightWhite: '#ededeb'
}

const LIGHT_THEME = {
  background: '#ffffff',
  foreground: '#1f1e1c',
  cursor: BRAND_ACCENT,
  cursorAccent: '#ffffff',
  selectionBackground: '#e4e2db',
  brightBlack: '#9b968c'
}
