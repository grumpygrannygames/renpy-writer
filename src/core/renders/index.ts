import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import type { RenderConfig, RenderEncoder } from '@shared/types'

/**
 * Syncing rendered stills into the game.
 *
 * Renders are produced outside the project and land in the game as .webp. The
 * job is deliberately narrow: the top level of one folder, stills only. No
 * recursion, because a render folder normally has `old/` and `Animations/`
 * sitting beside the frames that are actually current.
 *
 * This is the one place that goes to the filesystem directly rather than
 * through WorkspaceProvider: the inputs live outside the project entirely, and
 * the outputs are binary files written by an external encoder, neither of
 * which the text-oriented provider can express.
 */

/** Extensions treated as a still worth converting. */
const SOURCE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.bmp', '.gif', '.webp'])

/**
 * How much newer a source must be before it counts as re-rendered.
 *
 * Timestamps are not as precise as they look. A modification time can carry a
 * fraction of a millisecond that a Date cannot hold, and FAT-formatted drives
 * -- still normal for external disks holding render archives -- keep only
 * two-second granularity. Comparing exactly would call a file stale because it
 * is 0.4 ms older than itself, and re-encode a whole chapter on every scan.
 */
const STALE_TOLERANCE_MS = 2000

/** How far below the render folder to look when sub-folders are included. */
const MAX_DEPTH = 8

export type RenderItemStatus = 'new' | 'stale' | 'current'

export interface RenderItem {
  /** Source file name, e.g. ch9_2_leon_room_13.png. */
  name: string
  /** Output file name, e.g. ch9_2_leon_room_13.webp. */
  outputName: string
  status: RenderItemStatus
  sourceBytes: number
  /** Epoch milliseconds, for showing why something counts as stale. */
  sourceModified: number
  targetBytes?: number
  targetModified?: number
}

export interface RenderPlan {
  sourceDir: string
  targetDir: string
  items: RenderItem[]
  /** Sub-folders that were deliberately not looked at. */
  ignoredDirs: string[]
  /** Files in the folder that are not images. */
  ignoredFiles: number
  error?: string
}

export interface ConvertedItem {
  name: string
  outputName: string
  ok: boolean
  bytes?: number
  error?: string
  /**
   * Where the file landed, relative to the project root and POSIX-style.
   * This is what git wants to be told about, so the sync can offer to save
   * exactly what a conversion produced.
   */
  repoPath?: string
}

/** Absolute path of the folder an episode's renders are written to. */
export function targetDirFor(renpyRoot: string, config: RenderConfig): string {
  const sub = config.targetSubdir.replace(/^[\\/]+|[\\/]+$/g, '')
  return path.join(renpyRoot, 'game', 'images', ...(sub ? sub.split(/[\\/]/) : []))
}

/**
 * Work out what a sync would do, without doing any of it.
 *
 * A still is out of date when the source has been modified meaningfully later
 * than the file already in the game. Equal timestamps count as current: a
 * re-render always moves the clock forward by far more than the tolerance, so
 * anything stricter would rebuild the whole chapter every time.
 */
export async function planRenderSync(
  renpyRoot: string,
  config: RenderConfig
): Promise<RenderPlan> {
  const targetDir = targetDirFor(renpyRoot, config)
  const sourceDir = config.sourceDir?.trim() ?? ''
  const plan: RenderPlan = {
    sourceDir,
    targetDir,
    items: [],
    ignoredDirs: [],
    ignoredFiles: 0
  }

  if (!sourceDir) {
    return { ...plan, error: 'No render folder set for this episode yet.' }
  }

  const walk = async (dir: string, prefix: string, depth: number): Promise<string | null> => {
    let entries
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      if (prefix) return null // A sub-folder that cannot be read is not fatal.
      return code === 'ENOENT'
        ? `The render folder does not exist: ${dir}`
        : `Could not read the render folder: ${(e as Error).message}`
    }

    for (const entry of entries) {
      if (entry.isDirectory()) {
        // Dot-folders are never render output; they are version control and
        // caches, and descending into .git would be a long, useless walk.
        if (entry.name.startsWith('.')) continue
        if (!config.includeSubfolders) {
          plan.ignoredDirs.push(prefix + entry.name)
          continue
        }
        if (depth >= MAX_DEPTH) {
          plan.ignoredDirs.push(prefix + entry.name)
          continue
        }
        await walk(path.join(dir, entry.name), prefix + entry.name + '/', depth + 1)
        continue
      }
      if (!entry.isFile()) continue
      if (!SOURCE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        plan.ignoredFiles++
        continue
      }

      // The sub-folder is kept in the output path rather than flattened, so
      // two scenes can both hold a shot_01 without one overwriting the other.
      const name = prefix + entry.name
      const outputName = prefix + path.basename(entry.name, path.extname(entry.name)) + '.webp'
      const source = await fs.stat(path.join(dir, entry.name))
      const target = await statOrNull(path.join(targetDir, ...outputName.split('/')))

      plan.items.push({
        name,
        outputName,
        status: !target
          ? 'new'
          : source.mtimeMs - target.mtimeMs > STALE_TOLERANCE_MS
            ? 'stale'
            : 'current',
        sourceBytes: source.size,
        sourceModified: source.mtimeMs,
        targetBytes: target?.size,
        targetModified: target?.mtimeMs
      })
    }
    return null
  }

  const error = await walk(sourceDir, '', 0)
  if (error) return { ...plan, items: [], ignoredDirs: [], ignoredFiles: 0, error }

  plan.items.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
  return plan
}

async function statOrNull(file: string): Promise<{ size: number; mtimeMs: number } | null> {
  try {
    return await fs.stat(file)
  } catch {
    return null
  }
}

/**
 * The encoder path comes from project settings and is run without a shell, so
 * it needs no quoting rules -- but it is still worth refusing anything that is
 * not plainly a program name or a path.
 */
const SAFE_COMMAND = /^[A-Za-z0-9_.\\/:~ ()-]+$/

export const FFMPEG_MISSING =
  'ffmpeg was not found. Install it and make sure `ffmpeg` runs from a terminal, ' +
  'or set the full path to ffmpeg.exe in project settings.'

/**
 * Convert one still to .webp.
 *
 * Quality 100 is not lossless -- it is libwebp's top lossy setting, which on a
 * 1920x1080 render measures around 54 dB PSNR against the source PNG at about
 * a twelfth of the size. Lossless would be several times larger for no visible
 * gain in a game that scales the image anyway.
 */
/**
 * An encoder supplied by whoever is hosting this code.
 *
 * The built-in one lives in Electron, because it is Chromium's. Keeping it
 * behind a function means this module knows nothing about Electron and can run
 * on a server, which can pass its own or none at all.
 */
export type BuiltInEncode = (
  sourceFile: string,
  targetFile: string,
  quality: number
) => Promise<{ ok: boolean; bytes?: number; error?: string }>

export interface EncoderChoice {
  /** Defaults to the built-in encoder, which needs nothing installed. */
  encoder?: RenderEncoder
  /** Only consulted when encoder is 'ffmpeg'. */
  ffmpegPath?: string
  quality?: number
  /** The host's built-in encoder, when it has one. */
  builtin?: BuiltInEncode
}

export async function convertRender(
  choice: EncoderChoice,
  sourceFile: string,
  targetFile: string
): Promise<ConvertedItem> {
  const name = path.basename(sourceFile)
  const outputName = path.basename(targetFile)
  const quality = clampQuality(choice.quality)
  const ffmpeg = choice.ffmpegPath?.trim() || 'ffmpeg'

  if (choice.encoder === 'ffmpeg' && !SAFE_COMMAND.test(ffmpeg)) {
    return { name, outputName, ok: false, error: `"${ffmpeg}" is not a valid command.` }
  }

  await fs.mkdir(path.dirname(targetFile), { recursive: true })

  if (choice.encoder !== 'ffmpeg') {
    if (!choice.builtin) {
      return {
        name,
        outputName,
        ok: false,
        error: 'No built-in encoder is available here. Choose ffmpeg in project settings.'
      }
    }
    const result = await choice.builtin(sourceFile, targetFile, quality)
    if (!result.ok) return { name, outputName, ok: false, error: result.error }
    await stampSourceTime(sourceFile, targetFile)
    return { name, outputName, ok: true, bytes: result.bytes }
  }

  const args = [
    '-y',
    '-hide_banner',
    '-loglevel', 'error',
    '-i', sourceFile,
    '-c:v', 'libwebp',
    '-lossless', '0',
    '-quality', String(quality),
    '-compression_level', '6',
    '-pix_fmt', 'yuv420p',
    targetFile
  ]

  return new Promise<ConvertedItem>((resolve) => {
    let child
    try {
      child = spawn(ffmpeg, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    } catch {
      resolve({ name, outputName, ok: false, error: FFMPEG_MISSING })
      return
    }

    let stderr = ''
    child.stderr.on('data', (d) => (stderr += String(d)))
    child.on('error', (e: NodeJS.ErrnoException) => {
      resolve({
        name,
        outputName,
        ok: false,
        error: e.code === 'ENOENT' ? FFMPEG_MISSING : e.message
      })
    })
    child.on('close', async (code) => {
      if (code !== 0) {
        resolve({
          name,
          outputName,
          ok: false,
          error: stderr.trim().split('\n').pop() || `ffmpeg exited with code ${code}`
        })
        return
      }
      await stampSourceTime(sourceFile, targetFile)
      const written = await statOrNull(targetFile)
      resolve({ name, outputName, ok: true, bytes: written?.size })
    })
  })
}

/**
 * Stamp the source's time onto the output, so "up to date" means built from a
 * source with exactly this timestamp rather than merely written afterwards.
 * Without this a source dated ahead of the clock -- one machine running fast,
 * or a file restored with its times preserved -- would re-convert on every
 * scan and never settle.
 */
async function stampSourceTime(sourceFile: string, targetFile: string): Promise<void> {
  const source = await statOrNull(sourceFile)
  if (!source) return
  const stamp = new Date(source.mtimeMs)
  try {
    await fs.utimes(targetFile, stamp, stamp)
  } catch {
    // Not worth failing a good conversion over; the cost is one needless
    // re-encode next time.
  }
}

export function clampQuality(quality: number | undefined): number {
  if (typeof quality !== 'number' || Number.isNaN(quality)) return 100
  return Math.min(100, Math.max(1, Math.round(quality)))
}

/** Convert a batch, in order, reporting one result per item. */
export async function convertBatch(
  renpyRoot: string,
  config: RenderConfig,
  names: string[],
  choice: EncoderChoice
): Promise<ConvertedItem[]> {
  const targetDir = targetDirFor(renpyRoot, config)
  const results: ConvertedItem[] = []
  for (const name of names) {
    // `name` may carry a sub-folder, which is mirrored into the game so the
    // structure a render folder already has is the structure it keeps.
    const parts = name.split(/[\\/]/)
    const file = parts.pop()!
    const outputName = [...parts, path.basename(file, path.extname(file)) + '.webp'].join('/')
    const targetFile = path.join(targetDir, ...parts, path.basename(outputName))
    const result = await convertRender(
      choice,
      path.join(config.sourceDir ?? '', ...parts, file),
      targetFile
    )
    results.push(
      result.ok
        ? { ...result, repoPath: path.relative(renpyRoot, targetFile).split(path.sep).join('/') }
        : result
    )
  }
  return results
}

// ------------------------------------------------------------------- encoder

export interface FfmpegCandidate {
  command: string
  /** First line of `ffmpeg -version`, trimmed to something readable. */
  version: string
  /** Where it came from, for a person choosing between them. */
  label: string
}

export interface FfmpegStatus {
  ok: boolean
  /** The command that answered, when one did. */
  command?: string
  version?: string
  /** Working encoders found elsewhere on the machine. */
  candidates: FfmpegCandidate[]
  error?: string
}

/**
 * Places an ffmpeg tends to be when it is not on PATH.
 *
 * Several creative applications ship their own copy. Offering one is better
 * than leaving someone stuck, but the choice stays theirs: borrowing another
 * program's binary is a decision, not a default.
 */
function knownLocations(): { path: string; label: string }[] {
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA ?? ''
    const home = process.env.USERPROFILE ?? ''
    return [
      // Forward slashes on purpose. A backslash before an f in a quoted
      // string is a form-feed escape, so the obvious spelling of this path
      // produces a control character instead of a folder name.
      { path: 'C:/ffmpeg/bin/ffmpeg.exe', label: 'C:/ffmpeg' },
      { path: `${local}/Microsoft/WinGet/Links/ffmpeg.exe`, label: 'winget' },
      { path: `${home}/scoop/shims/ffmpeg.exe`, label: 'scoop' },
      { path: 'C:/ProgramData/chocolatey/bin/ffmpeg.exe', label: 'chocolatey' },
      {
        path: 'C:/Program Files (x86)/RenderIQ/tools/ffmpeg/windows/ffmpeg.exe',
        label: 'bundled with RenderIQ'
      }
    ]
  }

  const home = process.env.HOME ?? ''
  return [
    { path: '/opt/homebrew/bin/ffmpeg', label: 'Homebrew (Apple silicon)' },
    { path: '/usr/local/bin/ffmpeg', label: 'Homebrew or a local install' },
    { path: '/usr/bin/ffmpeg', label: 'system package' },
    { path: '/snap/bin/ffmpeg', label: 'snap' },
    { path: '/var/lib/flatpak/exports/bin/ffmpeg', label: 'flatpak' },
    { path: `${home}/.local/bin/ffmpeg`, label: 'user install' }
  ]
}


/** Ask a command for its version. Resolves to null when it is not usable. */
export function probeFfmpeg(command: string): Promise<string | null> {
  return new Promise((resolve) => {
    if (!SAFE_COMMAND.test(command)) {
      resolve(null)
      return
    }
    let child
    try {
      child = spawn(command, ['-version'], { stdio: ['ignore', 'pipe', 'ignore'] })
    } catch {
      resolve(null)
      return
    }
    let out = ''
    child.stdout.on('data', (d) => (out += String(d)))
    child.on('error', () => resolve(null))
    child.on('close', (code) => {
      if (code !== 0) {
        resolve(null)
        return
      }
      const first = out.split('\n')[0]?.trim() ?? ''
      resolve(first.slice(0, 120) || 'ffmpeg')
    })
  })
}

/**
 * Work out whether renders can be converted at all, before offering to convert
 * hundreds of them. A missing encoder fails identically for every image, so it
 * is worth one question up front rather than one failure per file.
 */
export async function findFfmpeg(configured?: string): Promise<FfmpegStatus> {
  const wanted = configured?.trim() || 'ffmpeg'
  const version = await probeFfmpeg(wanted)
  if (version) return { ok: true, command: wanted, version, candidates: [] }

  const candidates: FfmpegCandidate[] = []
  for (const { path: candidate, label } of knownLocations()) {
    if (candidate === wanted) continue
    const found = await probeFfmpeg(candidate)
    if (found) candidates.push({ command: candidate, version: found, label })
  }

  return {
    ok: false,
    candidates,
    error:
      configured?.trim() && configured.trim() !== 'ffmpeg'
        ? `"${configured.trim()}" did not run. Check the path in project settings.`
        : FFMPEG_MISSING
  }
}

/** Shown where an ffmpeg version string would otherwise go. */
export const BUILT_IN_ENCODER = 'Built in (Chromium libwebp) — nothing to install'
