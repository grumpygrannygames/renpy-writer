import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import type { RenpyRootCheck } from '@shared/types'

async function isDir(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isDirectory()
  } catch {
    return false
  }
}

async function hasRpy(dir: string): Promise<boolean> {
  try {
    return (await fs.readdir(dir)).some((f) => f.endsWith('.rpy'))
  } catch {
    return false
  }
}

/**
 * Validate that a folder is a Ren'Py project root and suggest where episode
 * files should live. Some projects keep script.rpy directly in game/, others use
 * game/scripts/, so the location has to be chosen per project rather than
 * assumed.
 */
export async function checkRenpyRoot(root: string): Promise<RenpyRootCheck> {
  if (!(await isDir(root))) {
    return { valid: false, scriptDirCandidates: [], reason: 'Folder does not exist.' }
  }
  const game = path.join(root, 'game')
  if (!(await isDir(game))) {
    return {
      valid: false,
      scriptDirCandidates: [],
      reason: 'No game/ folder here. Pick the Ren\u2019Py project root, the folder that contains game/.'
    }
  }

  const candidates: string[] = []
  if (await hasRpy(game)) candidates.push('')
  for (const entry of await fs.readdir(game, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    if (['cache', 'saves', 'tl', 'audio', 'images', 'gui', 'fonts', 'media'].includes(entry.name)) continue
    if (await hasRpy(path.join(game, entry.name))) candidates.push(entry.name)
  }

  if (candidates.length === 0) {
    return { valid: false, scriptDirCandidates: [], reason: 'No .rpy files found under game/.' }
  }
  return { valid: true, scriptDirCandidates: candidates }
}

/** Ren'Py files in the configured script folder, excluding engine boilerplate. */
const BOILERPLATE = new Set(['gui.rpy', 'options.rpy', 'screens.rpy'])

export async function listScriptFiles(root: string, scriptDir: string): Promise<string[]> {
  const dir = path.join(root, 'game', scriptDir)
  try {
    const files = await fs.readdir(dir)
    // Compare without the extension, or the '.' in "chapter_9.rpy" collates
    // against the '_' in "chapter_9_2.rpy" and puts the pair in the wrong order.
    const stem = (f: string): string => f.replace(/\.rpy$/, '')
    return files
      .filter((f) => f.endsWith('.rpy') && !BOILERPLATE.has(f))
      .sort((a, b) => stem(a).localeCompare(stem(b), undefined, { numeric: true }))
  } catch {
    return []
  }
}

/** "Episode 1" -> "episode_1". */
export function toFileSlug(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/['\u2019]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
}
