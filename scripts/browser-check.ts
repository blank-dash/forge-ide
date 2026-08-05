/**
 * Integration check for the built-in browser, run under Electron.
 *
 * The rest of the suite cannot cover this: `WebContentsView` only exists in a
 * real Electron main process, and the thing worth verifying is exactly the part
 * that a stub would fake — that a page actually loads into a native view laid
 * over the window, and that its text can be read back out.
 *
 *   npm run check:browser
 *
 * Bundled first, because `src/main/browser.ts` is TypeScript and the packaged
 * main bundle does not expose it as a separate module.
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { app, BrowserWindow } from 'electron'
import { Browser, normaliseUrl } from '../src/main/browser'

const PAGE = `<!doctype html>
<html><head><title>Forge browser check</title></head>
<body><main><h1>Hello from the check</h1><p>Second paragraph.</p></main></body></html>`

function serve(): Promise<{ server: import('node:http').Server; port: number }> {
  return new Promise((resolve) => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end(PAGE)
    })
    server.listen(0, '127.0.0.1', () => {
      // Port 0 means "pick a free one", so the real port is only known here.
      const address = server.address()
      resolve({ server, port: typeof address === 'object' && address ? address.port : 0 })
    })
  })
}

let failures = 0
function check(name: string, fn: () => void): void {
  try {
    fn()
    console.log(`  ok  ${name}`)
  } catch (error) {
    failures += 1
    console.error(`  FAIL ${name}\n       ${(error as Error).message}`)
  }
}

app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, width: 1200, height: 800 })
  const { server, port } = await serve()

  const states: import('../src/main/browser').BrowserState[] = []
  const browser = new Browser(
    () => window,
    (state) => states.push(state)
  )

  console.log('built-in browser')

  check('a bare hostname becomes https', () => {
    assert.equal(normaliseUrl('example.com'), 'https://example.com')
    assert.equal(normaliseUrl('  example.com/a/b  '), 'https://example.com/a/b')
  })

  check('an explicit scheme is left alone', () => {
    assert.equal(normaliseUrl('http://localhost:3000'), 'http://localhost:3000')
    assert.equal(normaliseUrl('https://a.test/x?y=1'), 'https://a.test/x?y=1')
  })

  check('a word with no dot or port is searched for, not resolved as a host', () => {
    // http://typescript/ would simply fail to resolve, which is never what was
    // meant by typing a word into the address bar.
    assert.ok(normaliseUrl('typescript generics').startsWith('https://duckduckgo.com/?q='))
    assert.ok(normaliseUrl('how do i').startsWith('https://duckduckgo.com/?q='))
  })

  check('a port is a port, not a URL scheme', () => {
    // The colon in localhost:5173 is not `scheme:` — reading it as one hands
    // the loader "localhost:5173", which cannot be opened at all.
    assert.equal(normaliseUrl('localhost:5173'), 'http://localhost:5173')
    assert.equal(normaliseUrl('127.0.0.1:8080/app'), 'http://127.0.0.1:8080/app')
    assert.equal(normaliseUrl('example.com:8443'), 'https://example.com:8443')
  })

  check('a local address defaults to http, not https', () => {
    // A dev server almost never has a certificate; https would show a TLS
    // error instead of the site.
    assert.equal(normaliseUrl('localhost'), 'http://localhost')
    assert.ok(normaliseUrl('https://localhost:3000').startsWith('https://'))
  })

  browser.setBounds({ x: 0, y: 40, width: 1200, height: 760 })
  browser.setVisible(true)

  const state = await browser.navigate(`http://127.0.0.1:${port}/`)

  check('a real page loads into the native view', () => {
    assert.equal(state.url, `http://127.0.0.1:${port}/`)
    assert.equal(state.title, 'Forge browser check')
    assert.equal(state.error, undefined)
  })

  const page = await browser.readText()

  check('the page can be read back as text', () => {
    assert.ok(page.text.includes('Hello from the check'), `got: ${JSON.stringify(page.text)}`)
    assert.ok(page.text.includes('Second paragraph.'))
    // innerText, not markup: no tags should survive.
    assert.ok(!page.text.includes('<h1>'))
  })

  check('state changes are published while loading', () => {
    assert.ok(states.length > 0, 'nothing was reported to the renderer')
    assert.ok(states.some((entry) => entry.title === 'Forge browser check'))
  })

  await browser.navigate('file:///etc/passwd').then(
    () => check('a non-web scheme is refused', () => assert.fail('file:// was accepted')),
    (error) =>
      check('a non-web scheme is refused', () =>
        assert.match(error.message, /http and https/i)
      )
  )

  browser.setVisible(false)
  check('hiding detaches the view', () => {
    assert.equal(window.contentView.children.length, 0)
  })

  browser.dispose()
  server.close()

  console.log(failures === 0 ? '\nbrowser check passed' : `\n${failures} failed`)
  app.exit(failures === 0 ? 0 : 1)
})
