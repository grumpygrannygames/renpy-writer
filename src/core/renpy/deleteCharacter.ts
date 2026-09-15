import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import type { VariableUse } from '@shared/api'
import type { WorkspaceProvider } from '../workspace/WorkspaceProvider'
import { collectRpyFiles } from './characters'
import { BINDING, CONDITION, PYTHON_BLOCK, SPEECH, bareWords, indentOf } from './renameVariable'

const SEPARATOR = /(\r\n|\n|\r)/

/**
 * Everywhere the script uses a character's variable.
 *
 * Read the same way a rename reads it: the `define` that makes it, the lines
 * where it is the speaker, and code that names it -- `$ ava.name`, a
 * condition, an `init python` block, another character built from it with
 * `Character(kind=ava)`. The word turning up in the story, or as an image
 * tag, is not a use.
 */
export async function usesOfVariable(root: string, varName: string): Promise<VariableUse> {
  const files = await collectRpyFiles(path.join(root, 'game'))
  const use: VariableUse = { varName, defines: [], speaks: 0, speakFiles: 0, mentions: [] }

  for (const file of files) {
    let text: string
    try {
      text = await fs.readFile(file, 'utf8')
    } catch {
      continue
    }
    const rel = path.relative(root, file).split(path.sep).join('/')
    const lines = text.split(/\r\n|\n|\r/)
    let spokeHere = false
    let python: number | null = null

    lines.forEach((line, i) => {
      const stripped = line.trim()
      if (python !== null && stripped && indentOf(line) <= python) python = null
      const inPython = python !== null
      if (PYTHON_BLOCK.test(stripped)) python = indentOf(line)

      if (!line.includes(varName) || stripped.startsWith('#')) return

      const bound = line.match(BINDING)
      if (bound && bound[2] === varName && /^define\b/.test(stripped)) {
        use.defines.push({ file: rel, line: i + 1, text: stripped })
        return
      }

      const speech = line.match(SPEECH)
      if (speech) {
        if (speech[2] === varName) {
          use.speaks++
          spokeHere = true
        }
        return
      }

      const isCode =
        inPython || stripped.startsWith('$') || CONDITION.test(stripped) ||
        /^(?:define|default)\b/.test(stripped)
      if (isCode && bareWords(line).includes(varName)) {
        use.mentions.push(`${rel}:${i + 1}  ${stripped}`)
      }
    })

    if (spokeHere) use.speakFiles++
  }

  return use
}

/**
 * A script with one `define` taken out.
 *
 * A definition can run over several lines -- `Character("Ava",` and then its
 * colour on the next -- and taking only the first would leave the rest as a
 * syntax error. So it goes to the bracket that closes it, reading past quotes.
 * Returns null when the line is not a definition, or never closes: better to
 * refuse than to cut to the end of the file.
 *
 * When that leaves two blank lines where there was one gap, one of them goes.
 */
export function removeDefinition(text: string, line: number): string | null {
  const parts = text.split(SEPARATOR)
  const start = (line - 1) * 2
  if (start < 0 || start >= parts.length || !BINDING.test(parts[start])) return null

  let depth = 0
  let quote: string | null = null
  let end = -1
  const from = parts[start].indexOf('=') + 1
  for (let k = start; k < parts.length && k <= start + 200; k += 2) {
    const row = parts[k]
    for (let i = k === start ? from : 0; i < row.length; i++) {
      const c = row[i]
      if (quote) {
        if (c === '\\') i++
        else if (c === quote) quote = null
        continue
      }
      if (c === '"' || c === "'") quote = c
      else if (c === '#') break
      else if (c === '(' || c === '[' || c === '{') depth++
      else if (c === ')' || c === ']' || c === '}') depth--
    }
    // A string only runs on past its line inside brackets; outside them the
    // line is over.
    if (depth <= 0) {
      end = k
      break
    }
  }
  if (end === -1) return null

  // The lines and the line endings after them.
  parts.splice(start, end - start + 2)
  const blank = (k: number): boolean => k >= 0 && k < parts.length && parts[k].trim() === ''
  if (blank(start - 2) && blank(start) && start + 1 < parts.length) parts.splice(start, 2)
  return parts.join('')
}

export interface DefinitionRemoval {
  ok: boolean
  reason?: string
  removed: number
}

/**
 * Take a character's definitions out of the script, if nothing needs them.
 *
 * Checked again here rather than trusted from what was shown: a line of
 * dialogue written between the dialog opening and the button being pressed
 * would otherwise be left speaking as somebody who no longer exists, and the
 * game would find out.
 */
export async function removeUnusedDefinitions(
  root: string,
  ws: WorkspaceProvider,
  varName: string
): Promise<DefinitionRemoval> {
  const use = await usesOfVariable(root, varName)
  if (use.speaks > 0) {
    return {
      ok: false,
      removed: 0,
      reason:
        `${varName} still speaks ${use.speaks} ${use.speaks === 1 ? 'line' : 'lines'}, ` +
        `so its definition was kept.`
    }
  }
  if (use.mentions.length > 0) {
    return {
      ok: false,
      removed: 0,
      reason: `${varName} is used in code (${use.mentions[0]}), so its definition was kept.`
    }
  }

  // Bottom of each file first, so the line numbers above still hold.
  const byFile = new Map<string, number[]>()
  for (const d of use.defines) byFile.set(d.file, [...(byFile.get(d.file) ?? []), d.line])

  // Every file worked out before any is written, so a definition that cannot
  // be taken out leaves all of them as they were rather than some.
  const rewritten = new Map<string, string>()
  let removed = 0
  for (const [file, lines] of byFile) {
    let text = await ws.readText(file)
    for (const line of [...lines].sort((a, b) => b - a)) {
      const next = removeDefinition(text, line)
      if (next === null) {
        return {
          ok: false,
          removed: 0,
          reason: `The definition of ${varName} at ${file}:${line} does not close, so it was left alone.`
        }
      }
      text = next
      removed++
    }
    rewritten.set(file, text)
  }
  for (const [file, text] of rewritten) await ws.writeText(file, text)
  return { ok: true, removed }
}
