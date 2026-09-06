import { promises as fs } from 'node:fs'
import * as path from 'node:path'

const MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif'
}

/** Video is recognised so it can be reported rather than inlined. */
const VIDEO = new Set(['.webm', '.mp4', '.ogv', '.avi', '.mkv'])

/** Previews are inline data URLs, so anything large is not worth sending. */
const MAX_BYTES = 4 * 1024 * 1024

const SKIP_DIRS = new Set(['cache', 'saves', 'tl', 'audio', 'fonts'])

interface ImageIndex {
  /** Posix path relative to game/, lowercased, to absolute path. */
  byPath: Map<string, string>
  /** File name without extension, lowercased, to absolute path. */
  byStem: Map<string, string>
  /** Explicit `image NAME = "path"` declarations, name lowercased. */
  declared: Map<string, string>
  /** Names declared as Movie(...) or another non-file displayable. */
  nonFile: Set<string>
  /** Names declared as a solid colour, e.g. image black = "#000". */
  colors: Map<string, string>
}

const cache = new Map<string, ImageIndex>()

/** image alice happy = "portraits/alice_happy.png" */
const IMAGE_DECL_RE = /^\s*image\s+([A-Za-z_][\w ]*?)\s*=\s*(.+)$/
const QUOTED_RE = /["']([^"']+\.(?:png|jpe?g|webp|gif|webm|mp4|ogv))["']/i
/** image black = "#000" — a solid colour rather than a file. */
const COLOR_DECL_RE = /^\s*["'](#[0-9a-fA-F]{3,8})["']\s*$/

async function walk(dir: string, base: string, index: ImageIndex, depth = 0): Promise<void> {
  if (depth > 6) return
  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue
      await walk(full, base, index, depth + 1)
      continue
    }
    const ext = path.extname(e.name).toLowerCase()
    if (!MIME[ext] && !VIDEO.has(ext)) continue

    const rel = path.relative(base, full).split(path.sep).join('/').toLowerCase()
    if (!index.byPath.has(rel)) index.byPath.set(rel, full)

    const stem = path.basename(e.name, path.extname(e.name)).toLowerCase()
    if (!index.byStem.has(stem)) index.byStem.set(stem, full)
  }
}

/** Collect `image NAME = ...` declarations, which override file naming. */
async function collectDeclarations(root: string, index: ImageIndex): Promise<void> {
  const scan = async (dir: string, depth = 0): Promise<void> => {
    if (depth > 4) return
    let entries
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const full = path.join(dir, e.name)
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue
        await scan(full, depth + 1)
      } else if (e.name.endsWith('.rpy')) {
        let text: string
        try {
          text = await fs.readFile(full, 'utf8')
        } catch {
          continue
        }
        for (const line of text.split(/\r?\n/)) {
          const m = line.match(IMAGE_DECL_RE)
          if (!m) continue
          // `image side alice happy = ...` is a portrait, handled elsewhere.
          const name = m[1].trim().toLowerCase()
          if (name.startsWith('side ')) continue
          const quoted = m[2].match(QUOTED_RE)
          const colour = m[2].match(COLOR_DECL_RE)
          if (quoted) index.declared.set(name, quoted[1])
          else if (colour) index.colors.set(name, colour[1])
          else index.nonFile.add(name)
        }
      }
    }
  }
  await scan(path.join(root, 'game'))
}

async function getIndex(root: string): Promise<ImageIndex> {
  const hit = cache.get(root)
  if (hit) return hit
  const index: ImageIndex = {
    byPath: new Map(),
    byStem: new Map(),
    declared: new Map(),
    nonFile: new Set(),
    colors: new Map()
  }
  await walk(path.join(root, 'game'), path.join(root, 'game'), index)
  await collectDeclarations(root, index)
  cache.set(root, index)
  return index
}

export function forgetImageIndex(root?: string): void {
  if (root) cache.delete(root)
  else cache.clear()
}

/**
 * Resolve a declared path the way Ren'Py does: it indexes everything under
 * game/ and matches on a path suffix, so "portraits/x.png" finds
 * game/images/portraits/x.png.
 */
function resolvePath(index: ImageIndex, relPath: string): string | null {
  const wanted = relPath.replace(/\\/g, '/').replace(/^\/+/, '').toLowerCase()
  const exact = index.byPath.get(wanted)
  if (exact) return exact
  for (const [rel, abs] of index.byPath) if (rel.endsWith('/' + wanted)) return abs
  const base = wanted.split('/').pop()
  return base ? (index.byStem.get(base.replace(/\.[^.]+$/, '')) ?? null) : null
}

export interface ImagePreview {
  /** Data URL, or null when there is nothing previewable. */
  dataUrl: string | null
  /** The image name that actually matched, which may be shorter than asked. */
  matched?: string
  /** What the name turned out to be. */
  kind?: 'image' | 'video' | 'color'
  /** Set when kind is 'color', e.g. '#000'. */
  color?: string
  reason?: string
}

/**
 * Resolve a Ren'Py image name such as `ch9_diner_1` or `alice happy`.
 *
 * An explicit `image` declaration wins. Otherwise Ren'Py auto-defines an image
 * for every file under game/images, named after the file, so the file stem is
 * tried next. Failing that, trailing attributes are dropped one at a time so
 * `alice happy` falls back to `alice`.
 */
export async function resolveImageName(root: string, name: string): Promise<ImagePreview> {
  const index = await getIndex(root)
  const parts = name.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return { dataUrl: null }

  for (let take = parts.length; take > 0; take--) {
    const candidate = parts.slice(0, take).join(' ')

    const colour = index.colors.get(candidate)
    if (colour) return { dataUrl: null, matched: candidate, kind: 'color', color: colour }

    if (index.nonFile.has(candidate)) {
      return { dataUrl: null, matched: candidate, reason: 'defined in code, not a file' }
    }

    const declared = index.declared.get(candidate)
    const target = declared
      ? resolvePath(index, declared)
      : (index.byStem.get(candidate) ?? index.byStem.get(candidate.replace(/ /g, '_')) ?? null)
    if (!target) continue

    const ext = path.extname(target).toLowerCase()
    if (VIDEO.has(ext)) {
      return { dataUrl: null, matched: candidate, kind: 'video', reason: path.basename(target) }
    }
    const mime = MIME[ext]
    if (!mime) continue

    try {
      const stat = await fs.stat(target)
      if (!stat.isFile()) continue
      if (stat.size > MAX_BYTES) {
        return { dataUrl: null, matched: candidate, reason: 'too large to preview' }
      }
      const buf = await fs.readFile(target)
      return {
        dataUrl: `data:${mime};base64,${buf.toString('base64')}`,
        matched: candidate,
        kind: 'image'
      }
    } catch {
      continue
    }
  }
  return { dataUrl: null }
}

/** Read a portrait by its declared path, for the expression preview. */
export async function readPortrait(root: string, relPath: string): Promise<string | null> {
  const index = await getIndex(root)
  const target = resolvePath(index, relPath)
  if (!target) return null

  const mime = MIME[path.extname(target).toLowerCase()]
  if (!mime) return null
  try {
    const stat = await fs.stat(target)
    if (!stat.isFile() || stat.size > MAX_BYTES) return null
    const buf = await fs.readFile(target)
    return `data:${mime};base64,${buf.toString('base64')}`
  } catch {
    return null
  }
}
