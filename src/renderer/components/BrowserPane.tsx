import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { BrowserState } from '../../preload'
import { useT } from '../i18n'
import { useStore } from '../store'

/**
 * The built-in browser.
 *
 * The page itself is a native view the main process lays over the window, not
 * anything in this document — so this component is a toolbar plus a hole. The
 * hole reports where it is; the main process puts the page there.
 *
 * That indirection is why the layout effect below matters more than it looks:
 * if the measurement is ever wrong or late, the page is drawn over a sidebar.
 */
export default function BrowserPane() {
  const t = useT()
  const slot = useRef<HTMLDivElement>(null)
  const [state, setState] = useState<BrowserState | null>(null)
  const [draft, setDraft] = useState('')
  const [editing, setEditing] = useState(false)

  /** Pushes the current geometry to the native view. */
  const report = useCallback((visible: boolean) => {
    const element = slot.current
    if (!element) return

    const rect = element.getBoundingClientRect()
    // Bounds are device-independent pixels; CSS pixels are not, once the
    // interface scale is anything but 100%.
    const zoom = window.forge.browser.zoomFactor()

    window.forge.browser.layout(
      {
        x: rect.left * zoom,
        y: rect.top * zoom,
        width: rect.width * zoom,
        height: rect.height * zoom
      },
      visible
    )
  }, [])

  useLayoutEffect(() => {
    report(true)

    const element = slot.current
    const observer = new ResizeObserver(() => report(true))
    if (element) observer.observe(element)

    // A resize observer sees the pane change size, but not the window moving a
    // scrollbar or a sidebar shifting everything sideways.
    const onWindowChange = (): void => report(true)
    window.addEventListener('resize', onWindowChange)

    return () => {
      observer.disconnect()
      window.removeEventListener('resize', onWindowChange)
      // Detach on unmount, or the page keeps painting over whatever replaced it.
      window.forge.browser.layout({ x: 0, y: 0, width: 0, height: 0 }, false)
    }
  }, [report])

  useEffect(() => {
    void window.forge.browser
      .state()
      .then(setState)
      .catch((error) => console.warn('[browser] state unavailable', error))
    return window.forge.browser.onState(setState)
  }, [])

  const go = (value: string): void => {
    setEditing(false)
    void window.forge.browser
      .navigate(value)
      .catch((error) =>
        useStore.getState().pushError(`Navigation failed: ${(error as Error).message}`)
      )
  }

  const shown = editing ? draft : (state?.url ?? '')

  return (
    <div className="browser">
      <div className="browser-bar">
        <button
          className="icon-btn"
          title={t('Back')}
          disabled={!state?.canGoBack}
          onClick={() => void window.forge.browser.back()}
        >
          ‹
        </button>
        <button
          className="icon-btn"
          title={t('Forward')}
          disabled={!state?.canGoForward}
          onClick={() => void window.forge.browser.forward()}
        >
          ›
        </button>
        <button
          className="icon-btn"
          title={state?.loading ? t('Stop') : t('Reload')}
          onClick={() =>
            void (state?.loading ? window.forge.browser.stop() : window.forge.browser.reload())
          }
        >
          {state?.loading ? '×' : '↻'}
        </button>

        <input
          className="input browser-url"
          value={shown}
          spellCheck={false}
          placeholder={t('Address, or something to search for')}
          onFocus={(event) => {
            setDraft(state?.url ?? '')
            setEditing(true)
            event.currentTarget.select()
          }}
          onBlur={() => setEditing(false)}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') go(event.currentTarget.value)
            if (event.key === 'Escape') {
              setEditing(false)
              event.currentTarget.blur()
            }
          }}
        />

        <button
          className="icon-btn"
          title={t('Open in your normal browser')}
          disabled={!state?.url}
          onClick={() => void window.forge.browser.openExternal()}
        >
          ↗
        </button>
      </div>

      {/* The native view is placed over exactly this box. */}
      <div className="browser-slot" ref={slot}>
        {!state?.url && !state?.error && (
          <div className="browser-empty">
            <h2>{t('Built-in browser')}</h2>
            <p>
              {t(
                'For looking at what you are building, and for the agent to show you a page. It keeps its own cookies, separate from anything else on this machine.'
              )}
            </p>
            <div className="browser-shortcuts">
              {['localhost:3000', 'localhost:5173', 'localhost:8080'].map((target) => (
                <button key={target} className="pill" onClick={() => go(target)}>
                  {target}
                </button>
              ))}
            </div>
          </div>
        )}

        {state?.error && (
          <div className="browser-empty">
            <h2>{t('Could not load that page')}</h2>
            <p className="browser-error">{state.error}</p>
          </div>
        )}
      </div>
    </div>
  )
}
