import { promises as fs } from 'node:fs'
import type { BrowserWindow } from 'electron'

/**
 * Converting stills without asking anyone to install anything.
 *
 * Electron ships Chromium, and Chromium contains libwebp -- the same encoder
 * ffmpeg calls. Measured against a finished 1920x1080 render, quality 0.995
 * lands within 122 bytes and 0.004 dB of artwork produced by ffmpeg at quality
 * 100, so nothing is given up by using it. What is gained is that a fresh
 * clone of this project can convert renders immediately: no download, no PATH,
 * no second licence to reason about, and alpha survives, which the ffmpeg
 * command line here does not manage because it flattens to yuv420p.
 *
 * The work happens in a hidden window so a chapter's worth of encoding cannot
 * make the interface stutter: that window is a separate process.
 */

/** Canvas quality is 0-1, and exactly 1 switches Chromium to lossless. */
export function canvasQuality(quality: number): number {
  return Math.min(quality / 100, 0.995)
}

const SETUP = `
  window.__encode = async (b64, quality) => {
    const bin = atob(b64)
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)

    const bitmap = await createImageBitmap(new Blob([bytes]))
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
    // alpha:true, because a portrait is transparent everywhere but the figure.
    const ctx = canvas.getContext('2d', { alpha: true })
    ctx.drawImage(bitmap, 0, 0)
    bitmap.close()

    const blob = await canvas.convertToBlob({ type: 'image/webp', quality })
    if (blob.type !== 'image/webp') {
      throw new Error('This build of Chromium did not produce WebP.')
    }

    const out = new Uint8Array(await blob.arrayBuffer())
    let s = ''
    for (let i = 0; i < out.length; i += 0x8000) {
      s += String.fromCharCode.apply(null, out.subarray(i, i + 0x8000))
    }
    return btoa(s)
  }
  true
`

let encoder: BrowserWindow | null = null
let starting: Promise<BrowserWindow> | null = null

async function encoderWindow(): Promise<BrowserWindow> {
  if (encoder && !encoder.isDestroyed()) return encoder
  if (starting) return starting

  starting = (async () => {
    // Imported here rather than at the top so this module can be loaded by
    // tooling that is not Electron -- the unit suite runs in plain Node.
    const { BrowserWindow: Window } = await import('electron')
    const win = new Window({
      show: false,
      width: 64,
      height: 64,
      webPreferences: {
        // Nothing is loaded from disk or the network here; the only input is a
        // string of base64 handed over deliberately.
        nodeIntegration: false,
        contextIsolation: true,
        // A hidden window is throttled by default, which would stall a long
        // run to a crawl.
        backgroundThrottling: false
      }
    })
    await win.loadURL('data:text/html,<!doctype html><meta charset="utf-8">')
    await win.webContents.executeJavaScript(SETUP)
    encoder = win
    starting = null
    return win
  })()

  return starting
}

/** Release the hidden window. Used when a project closes and by the tests. */
export function closeEncoder(): void {
  if (encoder && !encoder.isDestroyed()) encoder.destroy()
  encoder = null
  starting = null
}

/** Squeeze something readable out of whatever a page threw. */
function describe(e: unknown): string {
  if (typeof e === 'string') return e
  if (e instanceof Error && e.message) return e.message
  const record = e as Record<string, unknown>
  for (const key of ['message', 'error', 'description', 'name']) {
    const value = record?.[key]
    if (typeof value === 'string' && value) return value
  }
  try {
    const json = JSON.stringify(e)
    if (json && json !== '{}') return json
  } catch {
    // Circular or otherwise unserialisable; fall through.
  }
  return 'the encoder rejected the image'
}

export interface BuiltInResult {
  ok: boolean
  bytes?: number
  error?: string
}

/** Encode one still to .webp using Chromium's own encoder. */
export async function encodeWithChromium(
  sourceFile: string,
  targetFile: string,
  quality: number
): Promise<BuiltInResult> {
  let win: BrowserWindow
  try {
    win = await encoderWindow()
  } catch (e) {
    return { ok: false, error: `Could not start the image encoder: ${(e as Error).message}` }
  }

  let b64: string
  try {
    b64 = (await fs.readFile(sourceFile)).toString('base64')
  } catch (e) {
    return { ok: false, error: `Could not read the render: ${(e as Error).message}` }
  }

  let encoded: string
  try {
    // Base64 keeps this to one plain string argument. The cost is a third more
    // characters on the way in, which measures far below the encode itself.
    encoded = await win.webContents.executeJavaScript(
      `window.__encode("${b64}", ${canvasQuality(quality)})`
    )
  } catch (e) {
    // executeJavaScript rejects with whatever the page threw, which is often
    // not an Error at all; "[object Object]" tells nobody anything.
    const message = describe(e)
    return {
      ok: false,
      error: /decode|ImageBitmap|source image|not be decoded/i.test(message)
        ? 'The image could not be decoded. PNG, JPEG, BMP, GIF and WebP are understood.'
        : `The image could not be converted: ${message}`
    }
  }

  const out = Buffer.from(encoded, 'base64')
  if (out.length === 0) return { ok: false, error: 'The encoder returned nothing.' }

  try {
    await fs.writeFile(targetFile, out)
  } catch (e) {
    return { ok: false, error: `Could not write the image: ${(e as Error).message}` }
  }
  return { ok: true, bytes: out.length }
}
