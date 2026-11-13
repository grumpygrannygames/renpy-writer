/**
 * Draw resources/icon.svg at every size the apps need.
 *
 *     npx electron scripts/icons.mjs
 *
 * Chromium does the drawing, because it renders SVG exactly as the app will
 * and Electron is already here. Writes:
 *
 *   - Android launcher icons: the classic square and round ones, and the two
 *     layers of an adaptive icon (Android 8 and later crops those to whatever
 *     shape the phone uses, so the foreground is kept inside its safe zone).
 *   - Android splash screens, the logo on the app's background.
 *   - resources/icon.png, for the desktop window and anything else.
 */
import { app, BrowserWindow } from 'electron'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const svg = readFileSync(join(root, 'resources', 'icon.svg'), 'utf8')
const res = join(root, 'android', 'app', 'src', 'main', 'res')

/** The same picture with only some layers, or the foreground scaled about the centre. */
function variant({ background = true, foreground = true, scale = 1 } = {}) {
  let s = svg
  if (!background) s = s.replace(/<g id="background">[\s\S]*?<\/g>/, '')
  if (!foreground) s = s.replace(/<g id="foreground"[\s\S]*<\/g>\s*<\/svg>/, '</svg>')
  if (scale !== 1) {
    s = s.replace(
      '<g id="foreground"',
      `<g transform="translate(512 512) scale(${scale}) translate(-512 -512)"><g id="foreground"`
    ).replace(/<\/g>\s*<\/svg>/, '</g></g></svg>')
  }
  return 'data:image/svg+xml;base64,' + Buffer.from(s).toString('base64')
}

const DENSITIES = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 }

let win


/**
 * Draw on a canvas in the page and hand back a PNG.
 * shape: 'square' (rounded), 'circle', or 'full' (no mask).
 */
async function draw(src, width, height, { shape = 'full', fill = null, logo = 1 } = {}) {
  const url = await win.webContents.executeJavaScript(`(async () => {
    const img = new Image();
    img.src = ${JSON.stringify(src)};
    await img.decode();
    const c = document.createElement('canvas');
    c.width = ${width}; c.height = ${height};
    const g = c.getContext('2d');
    g.imageSmoothingQuality = 'high';
    if (${JSON.stringify(fill)}) { g.fillStyle = ${JSON.stringify(fill)}; g.fillRect(0, 0, c.width, c.height); }
    const size = Math.min(c.width, c.height) * ${logo};
    const x = (c.width - size) / 2, y = (c.height - size) / 2;
    g.save();
    if (${JSON.stringify(shape)} === 'circle') {
      g.beginPath(); g.arc(c.width / 2, c.height / 2, size / 2, 0, Math.PI * 2); g.clip();
    } else if (${JSON.stringify(shape)} === 'square') {
      const r = size * 0.22;
      g.beginPath(); g.roundRect(x, y, size, size, r); g.clip();
    }
    g.drawImage(img, x, y, size, size);
    g.restore();
    return c.toDataURL('image/png');
  })()`)
  return Buffer.from(url.split(',')[1], 'base64')
}

function save(file, png) {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, png)
}

// Started from whenReady, not awaited at the top: Electron does not become
// ready while the main script is still waiting on something at its top level.
app.whenReady().then(async () => {
win = new BrowserWindow({ show: false, width: 200, height: 200 })
await win.loadURL('data:text/html,<body></body>')

// On a tile of its own the logo can be larger than on an adaptive layer,
// which Android crops; the nib's tip still clears the rounded corners.
const full = variant({ scale: 1.15 })
// The adaptive foreground: 108dp canvas, of which the middle 66dp is never
// cropped. The bubble and nib reach about 0.62 of the width, so at 0.92
// they stay inside it.
const foreground = variant({ background: false, scale: 0.92 })

for (const [density, k] of Object.entries(DENSITIES)) {
  const dir = join(res, `mipmap-${density}`)
  save(join(dir, 'ic_launcher.png'), await draw(full, 48 * k, 48 * k, { shape: 'square' }))
  save(join(dir, 'ic_launcher_round.png'), await draw(full, 48 * k, 48 * k, { shape: 'circle' }))
  save(join(dir, 'ic_launcher_foreground.png'), await draw(foreground, 108 * k, 108 * k))
}

// Splash screens: the logo, small, on the app's own background.
const SPLASH = {
  'drawable/splash.png': [480, 320],
  ...Object.fromEntries(
    Object.entries({ mdpi: [320, 480], hdpi: [480, 800], xhdpi: [720, 1280], xxhdpi: [960, 1600], xxxhdpi: [1280, 1920] })
      .flatMap(([d, [w, h]]) => [
        [`drawable-port-${d}/splash.png`, [w, h]],
        [`drawable-land-${d}/splash.png`, [h, w]]
      ])
  )
}
const logoOnly = variant({ background: false })
for (const [file, [w, h]] of Object.entries(SPLASH)) {
  save(join(res, file), await draw(logoOnly, w, h, { fill: '#16161a', logo: 0.45 }))
}

save(join(root, 'resources', 'icon.png'), await draw(full, 1024, 1024, { shape: 'square' }))

console.log('icons written')
app.quit()
})
