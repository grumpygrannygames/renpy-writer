/**
 * Character colours come from the game's own Character() definitions, where
 * they were chosen to sit on the game's dialogue box -- not on this editor's
 * background. Some of them (Cromwell is #36393F) are nearly invisible on a
 * dark panel, so we keep the author's hue and lift only the lightness until
 * the text is actually readable.
 */

interface Rgb {
  r: number
  g: number
  b: number
}

function parseHex(hex: string): Rgb | null {
  let h = hex.trim().replace(/^#/, '')
  if (h.length === 3) h = h.split('').map((c) => c + c).join('')
  if (h.length === 8) h = h.slice(0, 6)
  if (h.length !== 6 || !/^[0-9a-fA-F]{6}$/.test(h)) return null
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16)
  }
}

const toHex = ({ r, g, b }: Rgb): string =>
  '#' + [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')

/** WCAG relative luminance. */
function luminance({ r, g, b }: Rgb): number {
  const f = (v: number): number => {
    const c = v / 255
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
  }
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
}

export function contrastRatio(a: Rgb, b: Rgb): number {
  const la = luminance(a)
  const lb = luminance(b)
  const [hi, lo] = la > lb ? [la, lb] : [lb, la]
  return (hi + 0.05) / (lo + 0.05)
}

function rgbToHsl({ r, g, b }: Rgb): { h: number; s: number; l: number } {
  const rr = r / 255
  const gg = g / 255
  const bb = b / 255
  const max = Math.max(rr, gg, bb)
  const min = Math.min(rr, gg, bb)
  const l = (max + min) / 2
  if (max === min) return { h: 0, s: 0, l }
  const d = max - min
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  let h: number
  if (max === rr) h = ((gg - bb) / d + (gg < bb ? 6 : 0)) / 6
  else if (max === gg) h = ((bb - rr) / d + 2) / 6
  else h = ((rr - gg) / d + 4) / 6
  return { h, s, l }
}

function hslToRgb(h: number, s: number, l: number): Rgb {
  if (s === 0) {
    const v = l * 255
    return { r: v, g: v, b: v }
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s
  const p = 2 * l - q
  const hue = (t: number): number => {
    let tt = t
    if (tt < 0) tt += 1
    if (tt > 1) tt -= 1
    if (tt < 1 / 6) return p + (q - p) * 6 * tt
    if (tt < 1 / 2) return q
    if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6
    return p
  }
  return { r: hue(h + 1 / 3) * 255, g: hue(h) * 255, b: hue(h - 1 / 3) * 255 }
}

/**
 * Return `color` lightened just enough to reach `minRatio` against `bg`,
 * preserving hue and saturation. Falls back to the given fallback if the
 * colour cannot be parsed.
 */
export function readableOn(
  color: string | undefined,
  bg: string,
  fallback: string,
  minRatio = 4.5
): string {
  if (!color) return fallback
  const fg = parseHex(color)
  const background = parseHex(bg)
  if (!fg || !background) return fallback
  if (contrastRatio(fg, background) >= minRatio) return toHex(fg)

  const { h, s } = rgbToHsl(fg)
  let best = fg
  // Walk lightness upward; stop as soon as it is legible.
  for (let l = rgbToHsl(fg).l; l <= 0.97; l += 0.02) {
    const candidate = hslToRgb(h, s, l)
    best = candidate
    if (contrastRatio(candidate, background) >= minRatio) break
  }
  return toHex(best)
}
