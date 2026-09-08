import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import { isVarName } from '@shared/renpy/names'
import type { WorkspaceProvider } from '../workspace/WorkspaceProvider'
import { collectRpyFiles } from './characters'

export interface VariableRenameResult {
  ok: boolean
  reason?: string
  /**
   * Lines that name the old variable somewhere this cannot safely rewrite,
   * as "file:line  the line itself". Nothing is written when there are any.
   */
  mentions?: string[]
  /** How many lines were rewritten, across how many files. */
  lines?: number
  files?: number
}

/**
 * A line that says who is speaking: `ava happy "..."`.
 *
 * The space before the quotation mark is optional, because scripts in the wild
 * are written as `alice doubting"Did you like it?"` and Ren'Py takes it.
 *
 * Everything between the speaker and the quote is image attributes, never
 * variables -- `david carlos "..."` is David wearing Carlos's pose, not two
 * characters -- so a speech line is only ever rewritten at its first word.
 */
const SPEECH = /^(\s*)([A-Za-z_]\w*)((?:\s+[A-Za-z_]\w*)*\s*")/
/** `define ava = ` or `default ava = `. */
const BINDING = /^(\s*(?:define|default)\s+)([A-Za-z_]\w*)(\s*=)/
/** A block of real Python, inside which every word is code. */
const PYTHON_BLOCK = /^(?:init\s+(?:-?\d+\s+)?)?python\b[^:]*:\s*$/
/** Statements whose contents are a Python expression. */
const CONDITION = /^(?:if|elif|while)\b/

/**
 * Identifiers on a line of code, ignoring anything inside quotes.
 *
 * Only ever applied to lines that are Python, where a quote is a string
 * delimiter. Applying it to prose would go wrong at the first apostrophe.
 */
function bareWords(line: string): string[] {
  const words: string[] = []
  let quote: string | null = null
  let word = ''
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (quote) {
      if (c === '\\') i++
      else if (c === quote) quote = null
      continue
    }
    if (c === '"' || c === "'") {
      quote = c
      continue
    }
    if (c === '#') break
    if (/[A-Za-z0-9_]/.test(c)) {
      word += c
      continue
    }
    if (word) {
      words.push(word)
      word = ''
    }
  }
  if (word) words.push(word)
  return words
}

const indentOf = (line: string): number => line.length - line.trimStart().length

/**
 * Rename a character's script variable everywhere it is used as one.
 *
 * Two places matter: the `define` that creates it, and the first word of every
 * line where it says who is speaking. Everything else that happens to contain
 * the same word is left exactly as it is -- an image tag (`show cook neutral`),
 * an image attribute on somebody else's line, a label, and the word appearing
 * in the story itself, which in a long script it certainly will.
 *
 * Where it refuses is Python: `$ cook.name = ...`, a condition, an `init
 * python` block. Rewriting those blind produces a game that loads and then
 * breaks an hour in; leaving them behind produces one that does not load at
 * all. So it does neither, and says where they are.
 */
export async function renameVariable(
  root: string,
  ws: WorkspaceProvider,
  oldName: string,
  newName: string
): Promise<VariableRenameResult> {
  if (oldName === newName) return { ok: true, lines: 0, files: 0 }
  if (!isVarName(newName)) {
    return {
      ok: false,
      reason: `${newName} cannot be a Ren'Py variable. Use letters, digits and underscores, starting with a letter.`
    }
  }

  const files = await collectRpyFiles(path.join(root, 'game'))
  const texts = new Map<string, string>()
  for (const file of files) {
    try {
      texts.set(file, await fs.readFile(file, 'utf8'))
    } catch {
      // A file that cannot be read cannot be rewritten either; better to stop
      // than to half-rename a project.
    }
  }

  // The name has to be free everywhere, not just in this file.
  for (const [file, text] of texts) {
    for (const line of text.split(/\r?\n/)) {
      const bound = line.match(BINDING)
      if (bound && bound[2] === newName) {
        return {
          ok: false,
          reason: `${newName} is already defined in ${path.relative(root, file).split(path.sep).join('/')}.`
        }
      }
    }
  }

  const mentions: string[] = []
  const rewritten = new Map<string, string>()
  let changedLines = 0

  for (const [file, text] of texts) {
    const rel = path.relative(root, file).split(path.sep).join('/')
    const parts = text.split(/(\r\n|\n|\r)/)
    let touched = false
    /** Indent of the `python:` we are inside, if any. */
    let python: number | null = null

    for (let i = 0; i < parts.length; i += 2) {
      const line = parts[i]
      if (line === undefined) continue
      const stripped = line.trim()

      // A Python block ends at the first line indented no further than it.
      if (python !== null && stripped && indentOf(line) <= python) python = null
      const inPython = python !== null
      if (PYTHON_BLOCK.test(stripped)) python = indentOf(line)

      if (!line.includes(oldName)) continue
      if (stripped.startsWith('#')) continue

      const bound = line.match(BINDING)
      if (bound && bound[2] === oldName) {
        parts[i] = line.replace(BINDING, `$1${newName}$3`)
        touched = true
        changedLines++
        continue
      }

      const speech = line.match(SPEECH)
      if (speech) {
        // Only the speaker is a variable; the rest of the line is attributes
        // and the words of the story.
        if (speech[2] === oldName) {
          parts[i] = `${speech[1]}${newName}${line.slice(speech[1].length + oldName.length)}`
          touched = true
          changedLines++
        }
        continue
      }

      // Everything left is only worth reading when it is code. Prose is full
      // of names, and of apostrophes, and means nothing to the engine.
      const isCode = inPython || stripped.startsWith('$') || CONDITION.test(stripped) ||
        /^(?:define|default)\b/.test(stripped)
      if (!isCode) continue
      if (!bareWords(line).includes(oldName)) continue

      mentions.push(`${rel}:${(i >> 1) + 1}  ${stripped}`)
    }

    if (touched) rewritten.set(rel, parts.join(''))
  }

  if (mentions.length > 0) {
    return {
      ok: false,
      reason:
        `${oldName} is used as more than a speaker, so renaming it here would ` +
        `leave those uses pointing at a name that no longer exists.`,
      mentions: mentions.slice(0, 12)
    }
  }

  for (const [rel, text] of rewritten) await ws.writeText(rel, text)
  return { ok: true, lines: changedLines, files: rewritten.size }
}
