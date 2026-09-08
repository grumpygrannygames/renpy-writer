import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import type { DiscoveredCharacter } from '@shared/types'
import {
  CHARACTER_RE,
  COLOR_RE,
  IMAGE_ATTR_RE,
  SIDE_IMAGE_RE,
  unescapeName
} from './patterns'

const SKIP_DIRS = new Set(['cache', 'saves', 'tl', 'audio', 'fonts', 'media', 'images', 'gui'])

export async function collectRpyFiles(dir: string, depth = 0): Promise<string[]> {
  if (depth > 3) return []
  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }

  const files: string[] = []
  for (const e of entries) {
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue
      files.push(...(await collectRpyFiles(path.join(dir, e.name), depth + 1)))
    } else if (e.name.endsWith('.rpy')) {
      files.push(path.join(dir, e.name))
    }
  }
  return files
}

/**
 * Read every .rpy under game/ and pull out the cast: who can speak, and which
 * side-portrait expressions each of them has. This is derived from the project
 * itself, so an existing game needs no manual character setup.
 */
export async function scanCharacters(root: string): Promise<DiscoveredCharacter[]> {
  const files = await collectRpyFiles(path.join(root, 'game'))

  const characters = new Map<string, DiscoveredCharacter>()
  /** image tag -> expression -> portrait path, relative to game/ */
  const portraitsByTag = new Map<string, Map<string, string>>()
  /** image tag -> the attribute-less default portrait */
  const defaultByTag = new Map<string, string>()

  for (const file of files) {
    let text: string
    try {
      text = await fs.readFile(file, 'utf8')
    } catch {
      continue
    }

    const relFile = path.relative(root, file).split(path.sep).join('/')
    let lineNo = 0

    for (const line of text.split(/\r?\n/)) {
      lineNo++
      const def = line.match(CHARACTER_RE)
      if (def) {
        const varName = def[1]
        // First definition wins; later ones are duplicates of the same name.
        if (!characters.has(varName)) {
          characters.set(varName, {
            varName,
            name: unescapeName(def[3]),
            color: line.match(COLOR_RE)?.[1],
            imageTag: line.match(IMAGE_ATTR_RE)?.[1],
            expressions: [],
            portraits: {},
            sourceFile: relFile,
            sourceLine: lineNo
          })
        }
        continue
      }

      const side = line.match(SIDE_IMAGE_RE)
      if (side) {
        const tag = side[1]
        const expr = side[2].trim()
        const file = side[3]
        if (!portraitsByTag.has(tag)) portraitsByTag.set(tag, new Map())
        // `image side alice = ...` with no attribute is the default portrait.
        if (expr) portraitsByTag.get(tag)!.set(expr, file)
        else if (!defaultByTag.has(tag)) defaultByTag.set(tag, file)
      }
    }
  }

  for (const c of characters.values()) {
    const tag = c.imageTag ?? c.varName
    const portraits = portraitsByTag.get(tag) ?? new Map<string, string>()
    c.expressions = [...portraits.keys()].sort((a, b) => a.localeCompare(b))
    c.portraits = Object.fromEntries(portraits)
    const fallback = defaultByTag.get(tag)
    if (fallback) c.defaultPortrait = fallback
  }

  return [...characters.values()].sort((a, b) => a.name.localeCompare(b.name))
}
