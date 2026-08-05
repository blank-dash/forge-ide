import { BrowserWindow, session, shell, WebContentsView } from 'electron'

/**
 * The built-in browser.
 *
 * Rendered as a native view laid over the window rather than an `<iframe>` or a
 * `<webview>`: framed pages refuse to load in an iframe (nearly every site sends
 * X-Frame-Options), and `<webview>` is deprecated and drags the whole app's
 * frame rate down with it. A `WebContentsView` is a real, separately-rendered
 * page — which also means it does not flow in the DOM, so the renderer has to
 * tell it where to sit.
 *
 * It gets its own session partition. Nothing you sign into here can read the
 * app's cookies, and nothing here is stored beside the app's own state.
 */

export interface BrowserState {
  url: string
  title: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  /** Set when the last navigation failed, so the pane can say why. */
  error?: string
}

export interface Bounds {
  x: number
  y: number
  width: number
  height: number
}

export const BROWSER_HOME = 'about:blank'

export class Browser {
  private view: WebContentsView | null = null
  private attached = false
  private visible = false
  private bounds: Bounds = { x: 0, y: 0, width: 0, height: 0 }
  private lastError: string | undefined

  constructor(
    private readonly getWindow: () => BrowserWindow | null,
    private readonly onState: (state: BrowserState) => void
  ) {}

  /** Creates the view on first use; opening the pane is what pays for it. */
  private ensure(): WebContentsView | null {
    if (this.view) return this.view

    const window = this.getWindow()
    if (!window) return null

    const view = new WebContentsView({
      webPreferences: {
        // A separate partition, so a site you sign into in here cannot see the
        // app's storage and its cookies outlive nothing but this browser.
        partition: 'persist:forge-browser',
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        spellcheck: false
      }
    })

    const contents = view.webContents

    // Popups go to the real browser: a window this pane cannot show or close
    // would otherwise be created with no way to reach it.
    contents.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
      return { action: 'deny' }
    })

    // Only the web. A file:// or app-internal URL loaded here would be reading
    // the machine through a surface that exists to show remote pages.
    contents.on('will-navigate', (event, url) => {
      if (!isBrowsable(url)) {
        event.preventDefault()
        this.lastError = 'Only http and https addresses can be opened here.'
        this.publish()
      }
    })

    contents.on('did-navigate', () => this.publish())
    contents.on('did-navigate-in-page', () => this.publish())
    contents.on('page-title-updated', () => this.publish())
    contents.on('did-start-loading', () => {
      this.lastError = undefined
      this.publish()
    })
    contents.on('did-stop-loading', () => this.publish())
    contents.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
      // -3 is ABORTED, which is what a redirect or a cancelled load reports.
      if (!isMainFrame || code === -3) return
      this.lastError = `${description || 'Could not load'} (${url})`
      this.publish()
    })

    this.view = view
    return view
  }

  /**
   * Where the pane sits, in window coordinates.
   *
   * Called on every layout change from the renderer, which is the only thing
   * that knows — a native view has no idea a sidebar was dragged.
   */
  setBounds(bounds: Bounds): void {
    this.bounds = {
      x: Math.round(bounds.x),
      y: Math.round(bounds.y),
      width: Math.max(0, Math.round(bounds.width)),
      height: Math.max(0, Math.round(bounds.height))
    }
    this.view?.setBounds(this.bounds)
  }

  /**
   * Shows or hides the pane.
   *
   * Detached rather than merely hidden when off: a view left in the tree keeps
   * painting over whatever replaced it, and the page keeps running timers and
   * video behind a screen nobody is looking at.
   */
  setVisible(visible: boolean): void {
    this.visible = visible
    const window = this.getWindow()
    if (!window) return

    if (!visible) {
      if (this.view && this.attached) {
        window.contentView.removeChildView(this.view)
        this.attached = false
      }
      return
    }

    const view = this.ensure()
    if (!view) return

    if (!this.attached) {
      window.contentView.addChildView(view)
      this.attached = true
    }
    view.setBounds(this.bounds)
    this.publish()
  }

  async navigate(input: string): Promise<BrowserState> {
    const view = this.ensure()
    if (!view) throw new Error('No window to open the browser in.')

    const url = normaliseUrl(input)
    if (!isBrowsable(url)) throw new Error('Only http and https addresses can be opened here.')

    this.lastError = undefined
    await view.webContents.loadURL(url).catch((error: Error) => {
      this.lastError = error.message
    })
    this.publish()
    return this.state()
  }

  back(): void {
    const contents = this.view?.webContents
    if (contents?.navigationHistory.canGoBack()) contents.navigationHistory.goBack()
  }

  forward(): void {
    const contents = this.view?.webContents
    if (contents?.navigationHistory.canGoForward()) contents.navigationHistory.goForward()
  }

  reload(): void {
    this.view?.webContents.reload()
  }

  stop(): void {
    this.view?.webContents.stop()
  }

  openExternally(): void {
    const url = this.view?.webContents.getURL()
    if (url && /^https?:\/\//i.test(url)) void shell.openExternal(url)
  }

  state(): BrowserState {
    const contents = this.view?.webContents
    if (!contents) {
      return { url: '', title: '', loading: false, canGoBack: false, canGoForward: false }
    }

    return {
      url: contents.getURL(),
      title: contents.getTitle(),
      loading: contents.isLoading(),
      canGoBack: contents.navigationHistory.canGoBack(),
      canGoForward: contents.navigationHistory.canGoForward(),
      error: this.lastError
    }
  }

  /**
   * The page as text, for the agent.
   *
   * `innerText` rather than the HTML: what the agent needs is what a reader
   * sees, and the markup of a modern page is mostly framework noise that would
   * fill the context window without adding anything.
   */
  async readText(limit = 40_000): Promise<{ url: string; title: string; text: string }> {
    const view = this.ensure()
    if (!view) throw new Error('The browser is not open.')

    const text = (await view.webContents
      .executeJavaScript(
        `(() => {
          const main = document.querySelector('main, article, [role="main"]')
          return (main || document.body)?.innerText ?? ''
        })()`,
        true
      )
      .catch(() => '')) as string

    const clean = text.replace(/\n{3,}/g, '\n\n').trim()
    return {
      url: view.webContents.getURL(),
      title: view.webContents.getTitle(),
      text: clean.length > limit ? `${clean.slice(0, limit)}\n\n[truncated]` : clean
    }
  }

  dispose(): void {
    if (!this.view) return

    const window = this.getWindow()
    if (window && this.attached) window.contentView.removeChildView(this.view)
    this.attached = false
    this.visible = false

    // Closing the contents is what actually stops the page; dropping the
    // reference alone leaves it running for the life of the process.
    if (!this.view.webContents.isDestroyed()) this.view.webContents.close()
    this.view = null
  }

  /** Wipes cookies and storage for the browser partition only. */
  async clearData(): Promise<void> {
    await session.fromPartition('persist:forge-browser').clearStorageData()
  }

  private publish(): void {
    if (this.visible || this.view) this.onState(this.state())
  }
}

/** Local names, which are almost always a dev server and almost never https. */
const LOOPBACK = /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:\d+)?(\/|$)/i

/** Turns what someone typed into something loadable. */
export function normaliseUrl(input: string): string {
  const trimmed = input.trim()
  if (!trimmed) return BROWSER_HOME

  // Requires the slashes. Matching a bare `scheme:` would swallow `localhost:3000`,
  // whose colon introduces a port, and hand the loader an address it cannot open.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return trimmed
  if (trimmed === BROWSER_HOME) return trimmed

  // http, not https: a dev server on localhost speaks plain http far more often
  // than not, and getting it wrong shows a TLS error instead of the site.
  if (LOOPBACK.test(trimmed)) return `http://${trimmed}`

  // A hostname needs either a dot or a port. A bare word is a search — nobody
  // typing "typescript generics" wants http://typescript/ and a DNS failure.
  const looksLikeHost = /^[^\s/]+(\.[^\s/.]{2,}|:\d+)/.test(trimmed)
  return looksLikeHost
    ? `https://${trimmed}`
    : `https://duckduckgo.com/?q=${encodeURIComponent(trimmed)}`
}

function isBrowsable(url: string): boolean {
  return /^https?:\/\//i.test(url) || url === BROWSER_HOME
}
