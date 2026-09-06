import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { parseDocument, type ScriptNode } from '@shared/renpy/document'

/**
 * Working out what two people disagreed about, in terms a writer can answer.
 *
 * git can already find the disagreements; what it cannot do is describe them.
 * Its answer is a file with markers in it, which for a .rpy is not a merge in
 * progress but a broken game. So the alignment is left to git -- it is good at
 * it, and reimplementing diff3 to be slightly wrong would help nobody -- and
 * only the presentation is done here: each disagreement becomes a question
 * with two answers, in the shape the editor already understands.
 */

export type Take = 'mine' | 'theirs' | 'custom'

export interface ConflictSide {
  /** The lines exactly as they are, which is what gets written back. */
  lines: string[]
  /** The same lines parsed, so the panel can show a speaker instead of syntax. */
  nodes: ScriptNode[]
}

export interface ConflictRegion {
  /** Position within its file's list, and how a decision refers back to it. */
  index: number
  file: string
  /** Line in the merged file where this begins, for orientation only. */
  line: number
  mine: ConflictSide
  theirs: ConflictSide
  /** What both sides started from. Shown only when somebody asks. */
  base: ConflictSide
}

export interface FileConflict {
  file: string
  regions: ConflictRegion[]
}

export interface Decision {
  file: string
  index: number
  take: Take
  /** Used when take is 'custom'. Written as given, minus a trailing newline. */
  text?: string
}

interface RunResult {
  code: number
  stdout: string
  stderr: string
}

function run(cwd: string, args: string[]): Promise<RunResult> {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch {
      resolve({ code: -1, stdout: '', stderr: 'git could not be started.' })
      return
    }
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => (stdout += String(d)))
    child.stderr.on('data', (d) => (stderr += String(d)))
    child.on('error', (e: Error) => resolve({ code: -1, stdout: '', stderr: e.message }))
    child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }))
  })
}

/**
 * Line endings, which on Windows are not a detail.
 *
 * git stores LF and checks out CRLF, so the file on disk and the file `git
 * show` hands back differ on every single line. Compared as they are, two
 * versions of the same untouched script disagree about all of it -- one
 * enormous conflict where there was no disagreement at all.
 *
 * So everything is compared as LF, and what gets written back is converted to
 * whatever the file on disk was already using. Nothing changes ending style
 * behind somebody's back.
 */
const LF = (text: string): string => text.replace(/\r\n/g, '\n')
const eolOf = (text: string): string => (/\r\n/.test(text) ? '\r\n' : '\n')
const toEol = (text: string, eol: string): string =>
  eol === '\n' ? LF(text) : LF(text).replace(/\n/g, '\r\n')

const side = (lines: string[]): ConflictSide => ({
  lines,
  nodes: parseDocument(lines.join('\n')).nodes
})

/**
 * A merged file as alternating certainties and questions.
 *
 * Keeping the settled text alongside the disagreements is what makes applying
 * a decision a matter of joining a list, rather than a second merge that could
 * disagree with the first.
 */
type Segment = { settled: string[] } | { region: ConflictRegion }

const MINE = /^<{7}/
const BASE = /^\|{7}/
const SPLIT = /^={7}$/
const THEIRS = /^>{7}/

/** Split `git merge-file --diff3` output into settled text and questions. */
function segment(merged: string, file: string): Segment[] {
  const out: Segment[] = []
  const lines = merged.split('\n')
  let settled: string[] = []
  let at = 0
  let index = 0

  while (at < lines.length) {
    if (!MINE.test(lines[at])) {
      settled.push(lines[at])
      at++
      continue
    }

    if (settled.length > 0) {
      out.push({ settled })
      settled = []
    }
    const startedAt = at
    at++

    const mine: string[] = []
    while (at < lines.length && !BASE.test(lines[at]) && !SPLIT.test(lines[at])) {
      mine.push(lines[at])
      at++
    }
    const base: string[] = []
    if (at < lines.length && BASE.test(lines[at])) {
      at++
      while (at < lines.length && !SPLIT.test(lines[at])) {
        base.push(lines[at])
        at++
      }
    }
    const theirs: string[] = []
    if (at < lines.length && SPLIT.test(lines[at])) {
      at++
      while (at < lines.length && !THEIRS.test(lines[at])) {
        theirs.push(lines[at])
        at++
      }
    }
    if (at < lines.length && THEIRS.test(lines[at])) at++

    out.push({
      region: {
        index: index++,
        file,
        line: startedAt + 1,
        mine: side(mine),
        theirs: side(theirs),
        base: side(base)
      }
    })
  }

  if (settled.length > 0) out.push({ settled })
  return out
}

/** Read one path at one revision. Returns '' for a file that was not there. */
async function show(cwd: string, rev: string, file: string): Promise<string> {
  const got = await run(cwd, ['show', `${rev}:${file}`])
  return got.code === 0 ? got.stdout : ''
}

/**
 * Ask git to align the three versions, without letting it touch anything.
 *
 * The temporary files exist because `git merge-file` reads files rather than
 * standard input. They are removed on the way out, and nothing in the repo is
 * written at any point.
 */
async function alignedSegments(
  cwd: string,
  file: string
): Promise<{ segments: Segment[]; eol: string } | null> {
  const mergeBase = await run(cwd, ['merge-base', 'HEAD', '@{u}'])
  if (mergeBase.code !== 0) return null

  const [baseText, theirText] = await Promise.all([
    show(cwd, mergeBase.stdout.trim(), file),
    show(cwd, '@{u}', file)
  ])

  let mineText: string
  try {
    mineText = await fs.readFile(path.join(cwd, file), 'utf8')
  } catch {
    return null
  }

  const eol = eolOf(mineText)
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'rpw-merge-'))
  try {
    const at = (name: string): string => path.join(scratch, name)
    await Promise.all([
      fs.writeFile(at('mine'), LF(mineText)),
      fs.writeFile(at('base'), LF(baseText)),
      fs.writeFile(at('theirs'), LF(theirText))
    ])
    const merged = await run(cwd, [
      'merge-file',
      '-p',
      '--diff3',
      at('mine'),
      at('base'),
      at('theirs')
    ])
    // Exit code is the number of conflicts; only a negative value is an error.
    if (merged.code < 0) return null
    return { segments: segment(LF(merged.stdout), file), eol }
  } finally {
    await fs.rm(scratch, { recursive: true, force: true })
  }
}

/** The disagreements in the named files, ready to be shown. */
export async function readConflicts(cwd: string, files: string[]): Promise<FileConflict[]> {
  const out: FileConflict[] = []
  for (const file of files) {
    const aligned = await alignedSegments(cwd, file)
    if (!aligned) continue
    const regions = aligned.segments
      .filter((s): s is { region: ConflictRegion } => 'region' in s)
      .map((s) => s.region)
    if (regions.length > 0) out.push({ file, regions })
  }
  return out
}

/**
 * The file as it would read once every question is answered.
 *
 * Refuses rather than guesses: a region nobody decided is a line this has no
 * business choosing, and silently keeping one side would be a decision made on
 * somebody's behalf without telling them.
 */
export async function resolvedText(
  cwd: string,
  file: string,
  decisions: Decision[]
): Promise<{ text: string } | { missing: number[] }> {
  const aligned = await alignedSegments(cwd, file)
  if (!aligned) return { missing: [] }

  const chosen = new Map(decisions.filter((d) => d.file === file).map((d) => [d.index, d]))
  const missing: number[] = []
  const parts: string[] = []

  for (const piece of aligned.segments) {
    if ('settled' in piece) {
      parts.push(...piece.settled)
      continue
    }
    const decision = chosen.get(piece.region.index)
    if (!decision) {
      missing.push(piece.region.index)
      continue
    }
    if (decision.take === 'custom') {
      parts.push(...LF(decision.text ?? '').replace(/\n$/, '').split('\n'))
    } else {
      parts.push(...(decision.take === 'mine' ? piece.region.mine.lines : piece.region.theirs.lines))
    }
  }

  if (missing.length > 0) return { missing }
  return { text: toEol(parts.join('\n'), aligned.eol) }
}
