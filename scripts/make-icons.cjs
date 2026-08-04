/**
 * Rasterises build/icon.svg into the PNGs electron-builder needs.
 *
 * Run with `npm run icons`. Electron is already a dependency and Chromium is a
 * better SVG renderer than anything we could add, so there is no reason to pull
 * in a rasteriser just for this.
 */
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const ROOT = path.join(__dirname, '..')
const SOURCE = path.join(ROOT, 'build', 'icon.svg')
const MASTER = 1024

const OUTPUTS = [
  { file: path.join(ROOT, 'build', 'icon.png'), size: 1024 },
  { file: path.join(ROOT, 'build', 'icon-512.png'), size: 512 },
  { file: path.join(ROOT, 'build', 'icon-256.png'), size: 256 },
  { file: path.join(ROOT, 'resources', 'tray.png'), size: 64 }
]

/**
 * Renders once at full size and downscales from that single capture.
 * Opening a fresh transparent BrowserWindow per size proved unreliable, and
 * Chromium's resampler is good enough that one render is also better quality
 * than several independent ones.
 */
async function renderMaster(svg) {
  const window = new BrowserWindow({
    width: MASTER,
    height: MASTER,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    useContentSize: true
  })

  const page = `<!doctype html>
    <html><head><meta charset="utf-8"><style>
      html,body{margin:0;padding:0;background:transparent;overflow:hidden}
      svg{display:block;width:${MASTER}px;height:${MASTER}px}
    </style></head><body>${svg}</body></html>`

  // A temp file rather than a data: URL — Chromium rejects long data URLs.
  const scratch = path.join(os.tmpdir(), `forge-icon-master.html`)
  fs.writeFileSync(scratch, page, 'utf8')

  try {
    await window.loadFile(scratch)
    // One frame of settle time; capturing too early yields a blank bitmap.
    await new Promise((resolve) => setTimeout(resolve, 200))
    return await window.webContents.capturePage()
  } finally {
    fs.rmSync(scratch, { force: true })
    window.destroy()
  }
}

app.disableHardwareAcceleration()

app.whenReady().then(async () => {
  try {
    const master = await renderMaster(fs.readFileSync(SOURCE, 'utf8'))

    for (const { file, size } of OUTPUTS) {
      const image = size === MASTER ? master : master.resize({ width: size, height: size, quality: 'best' })
      const png = image.toPNG()
      if (png.length === 0) throw new Error(`empty bitmap at ${size}px`)

      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, png)
      console.log(`wrote ${path.relative(ROOT, file)} (${size}px, ${png.length} bytes)`)
    }

    app.exit(0)
  } catch (error) {
    console.error('icon generation failed:', error)
    app.exit(1)
  }
})
