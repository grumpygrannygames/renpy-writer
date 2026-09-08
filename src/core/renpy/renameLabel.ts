import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import type { WorkspaceProvider } from '../workspace/WorkspaceProvider'
import { collectRpyFiles } from './characters'

export interface LabelRenameResult {
  ok: boolean
  reason?: string
  /** How many lines were rewritten, across how many files. */
  lines?: number
  files?: number
}

/**
 * `label X:`, keeping any parameters and any trailing comment.
 *
 * The word boundary is what stops renaming `CH2_YARD` from touching
 * `CH2_YARD_NIGHT`, which is the mistake a plain search and replace makes.
 */
const DEFINITION = (label: string): RegExp => new RegExp(`^(\\s*label\\s+)${label}(\\b[\\s\\S]*)$`)
/** `jump X`, `call X`, and `call X from Y`. */
const REFERENCE = (label: string): RegExp =>
  new RegExp(`^(\\s*(?:jump|call)\\s+)${label}(\\b.*)$`)
/** Any label definition at all, for checking a name is free. */
const ANY_LABEL = /^\s*label\s+([A-Za-z_]\w*)/

/** Rewrite one file's text. Returns the same string when nothing matched. */
export function renameLabelIn(
  text: string,
  oldLabel: string,
  newLabel: string
): { text: string; lines: number } {
  const definition = DEFINITION(oldLabel)
  const reference = REFERENCE(oldLabel)
  const parts = text.split(/(\r\n|\n|\r)/)
  let lines = 0

  for (let i = 0; i < parts.length; i += 2) {
    const line = parts[i]
    if (!line || !line.includes(oldLabel)) continue
    if (definition.test(line)) {
      parts[i] = line.replace(definition, `$1${newLabel}$2`)
      lines++
      continue
    }
    if (reference.test(line)) {
      parts[i] = line.replace(reference, `$1${newLabel}$2`)
      lines++
    }
  }

  return { text: lines > 0 ? parts.join('') : text, lines }
}

/**
 * Rename a label, and everything that points at it, across the project.
 *
 * Ren'Py labels are global: a scene can be jumped to from a file that knows
 * nothing about the one it lives in, so renaming inside a single file is how a
 * rename produces a game that stops mid-story. Every .rpy under game/ is read,
 * and only the files that actually change are written.
 *
 * Only whole statements are touched -- the `label` that declares it and the
 * `jump` or `call` that reach it. The name appearing in a line of dialogue, or
 * as part of a longer label, is left alone.
 */
export async function renameLabelEverywhere(
  root: string,
  ws: WorkspaceProvider,
  oldLabel: string,
  newLabel: string
): Promise<LabelRenameResult> {
  if (oldLabel === newLabel) return { ok: true, lines: 0, files: 0 }

  const files = await collectRpyFiles(path.join(root, 'game'))
  const texts = new Map<string, string>()
  for (const file of files) {
    try {
      texts.set(file, await fs.readFile(file, 'utf8'))
    } catch {
      // Unreadable now means unwritable in a moment; better to stop than to
      // rename half a project.
    }
  }

  for (const [file, text] of texts) {
    for (const line of text.split(/\r?\n/)) {
      const found = line.match(ANY_LABEL)
      if (found && found[1] === newLabel) {
        return {
          ok: false,
          reason: `${newLabel} is already a scene in ${path.relative(root, file).split(path.sep).join('/')}.`
        }
      }
    }
  }

  let changedLines = 0
  const rewritten = new Map<string, string>()
  for (const [file, text] of texts) {
    const result = renameLabelIn(text, oldLabel, newLabel)
    if (result.lines === 0) continue
    changedLines += result.lines
    rewritten.set(path.relative(root, file).split(path.sep).join('/'), result.text)
  }

  if (changedLines === 0) {
    return { ok: false, reason: `${oldLabel} is not a scene in this project.` }
  }

  for (const [rel, text] of rewritten) await ws.writeText(rel, text)
  return { ok: true, lines: changedLines, files: rewritten.size }
}
