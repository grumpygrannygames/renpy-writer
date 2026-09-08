import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import { characterVarName, defineLine } from '@shared/renpy/names'
import type { WorkspaceProvider } from '../workspace/WorkspaceProvider'
import { collectRpyFiles } from './characters'

/** Where a definition RW writes for you goes, relative to the project root. */
export const CHARACTERS_FILE = 'game/characters.rpy'

export interface DefineResult {
  ok: boolean
  reason?: string
  /** The variable the character was defined as. */
  varName?: string
  /** The file it went into, relative to the project root. */
  file?: string
  /** Whether that file had to be created. */
  created?: boolean
}

/** Anything the project already binds a name to, whatever it is bound to. */
const BINDING_RE = /^\s*(?:define|default)\s+([A-Za-z_]\w*)\s*=/

/**
 * Every name the project already defines.
 *
 * Wider than the cast on purpose. A new character called Music would collide
 * with `define music = ...` as surely as with another Character, and Ren'Py
 * would refuse to load the game either way.
 */
async function definedNames(root: string): Promise<Set<string>> {
  const names = new Set<string>()
  for (const file of await collectRpyFiles(path.join(root, 'game'))) {
    let text: string
    try {
      text = await fs.readFile(file, 'utf8')
    } catch {
      continue
    }
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(BINDING_RE)
      if (m) names.add(m[1])
    }
  }
  return names
}

/**
 * Write `define x = Character("Name")` for somebody who is not in the script
 * yet.
 *
 * It goes at the end of game/characters.rpy, which is created if it is not
 * there. One fixed place, rather than a guess at which of the writer's files
 * is the characters one: Ren'Py loads every .rpy under game/ regardless, and
 * a definition that always lands somewhere predictable is easier to live with
 * than one that lands somewhere clever.
 *
 * Nothing already in the file is touched. This appends, and appends only.
 */
export async function defineCharacter(
  root: string,
  ws: WorkspaceProvider,
  displayName: string
): Promise<DefineResult> {
  const name = displayName.trim()
  if (!name) return { ok: false, reason: 'A character needs a name.' }
  if (/[\r\n]/.test(name)) return { ok: false, reason: 'A name cannot span lines.' }

  const varName = characterVarName(name, await definedNames(root))
  const line = defineLine(varName, name)

  const exists = await ws.exists(CHARACTERS_FILE)
  if (!exists) {
    await ws.writeText(CHARACTERS_FILE, line + '\n')
    return { ok: true, varName, file: CHARACTERS_FILE, created: true }
  }

  const current = await ws.readText(CHARACTERS_FILE)
  // Whatever the file already uses. A project written on Windows keeps its
  // CRLF rather than gaining one stray LF line in the middle of a diff.
  const eol = /\r\n/.test(current) ? '\r\n' : '\n'
  const body = current.length === 0 || current.endsWith('\n') ? current : current + eol
  await ws.writeText(CHARACTERS_FILE, body + line + eol)
  return { ok: true, varName, file: CHARACTERS_FILE, created: false }
}
