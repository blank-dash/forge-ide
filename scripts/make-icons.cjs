/**
 * Produces every icon size the packager needs from one source.
 *
 * Prefers build/icon-source.png — the artwork as drawn — and falls back to
 * rasterising build/icon.svg. Electron is already a dependency and Chromium
 * resamples better than anything we could add for this, so there is no reason
 * to pull in an image library.
 */
const { app, BrowserWindow, nativeImage } = require('electron')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const ROOT = path.join(__dirname, '..')
const PNG_SOURCE = path.join(ROOT, 'build', 'icon-source.png')
const SVG_SOURCE = path.join(ROOT, 'build', 'icon.svg')
const MASTER = 1024

const OUTPUTS = [
  { file: path.join(ROOT, 'build', 'icon.png'), size: 1024 },
  { file: path.join(ROOT, 'build', 'icon-512.png'), size: 512 },
  { file: path.join(ROOT, 'build', 'icon-256.png'), size: 256 },
  { file: path.join(ROOT, 'resources', 'tray.png'), size: 64 }
]

/**
 * Renders the SVG once at full size. Opening a fresh transparent window per
 * size proved unreliable, and one render downscaled is also better quality
 * than several independent ones.
 */
async function renderSvg(svg) {
  const window = new BrowserWindow({
    width: MASTER,
    height: MASTER,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    useContentSize: true
  })

  const page = '<!doctype html><html><head><meta charset="utf-8"><style>' +
    'html,body{margin:0;padding:0;background:transparent;overflow:hidden}' +
    'svg{display:block;width:' + MASTER + 'px;height:' + MASTER + 'px}' +
    '</style></head><body>' + svg + '</body></html>'

  const scratch = path.join(os.tmpdir(), 'forge-icon-master.html')
  fs.writeFileSync(scratch, page, 'utf8')

  try {
    await window.loadFile(scratch)
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
    let master
    if (fs.existsSync(PNG_SOURCE)) {
      master = nativeImage.createFromPath(PNG_SOURCE)
      if (master.isEmpty()) throw new Error('could not read ' + PNG_SOURCE)
      console.log('source: icon-source.png (' + master.getSize().width + 'px)')
    } else {
      master = await renderSvg(fs.readFileSync(SVG_SOURCE, 'utf8'))
      console.log('source: icon.svg')
    }

    for (const out of OUTPUTS) {
      const image =
        master.getSize().width === out.size
          ? master
          : master.resize({ width: out.size, height: out.size, quality: 'best' })
      const png = image.toPNG()
      if (png.length === 0) throw new Error('empty bitmap at ' + out.size + 'px')

      fs.mkdirSync(path.dirname(out.file), { recursive: true })
      fs.writeFileSync(out.file, png)
      console.log('wrote ' + path.relative(ROOT, out.file) + ' (' + out.size + 'px, ' + png.length + ' bytes)')
    }

    app.exit(0)
  } catch (error) {
    console.error('icon generation failed:', error)
    app.exit(1)
  }
})
