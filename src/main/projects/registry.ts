import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import { app } from 'electron'
import type { ProjectRef } from '@shared/types'

/**
 * The list of known projects lives in userData, not in any game folder, so
 * opening the app does not require a project to be present.
 *
 * This file is the only record that a project exists. Losing it does not
 * destroy any work, but it does leave someone staring at an empty app with no
 * idea where their projects went, so the rules here are strict: a read that
 * fails is reported rather than reported as "empty", a write never truncates
 * the only copy, and nothing is written on top of a list that could not be
 * read in the first place.
 */
function registryPath(): string {
  return path.join(app.getPath('userData'), 'projects.json')
}

const backupPath = (): string => registryPath() + '.bak'

export interface RegistryRead {
  projects: ProjectRef[]
  /** Set when the file exists but could not be used. Never set for a fresh install. */
  error?: string
  /** Path of the file, so the UI can say where to look. */
  path: string
  /** True when the list came from the backup because the main file was unusable. */
  recovered?: boolean
}

function parse(raw: string): ProjectRef[] | null {
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed.projects) ? parsed.projects : null
  } catch {
    return null
  }
}

/**
 * Read the registry, distinguishing "there is nothing here yet" from "I could
 * not read what is here". The difference matters: the first is a new install
 * and the second is a problem that must not be presented as an empty list.
 */
export async function readRegistryDetailed(): Promise<RegistryRead> {
  const file = registryPath()

  let raw: string
  try {
    raw = await fs.readFile(file, 'utf8')
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    if (code === 'ENOENT') {
      // Missing is usually a fresh install. It is not always: a file can be
      // deleted, moved, quarantined by a virus scanner, or lost to a sync
      // conflict, and every one of those leaves the backup sitting beside it
      // holding the real list.
      //
      // This was the one failure that ignored the backup, and it is the most
      // likely one -- so the case where recovery mattered most was the case
      // that did not try. Reported rather than silently repaired, because a
      // list that keeps having to be recovered is worth knowing about.
      const rescued = await readBackup()
      if (rescued && rescued.length > 0) {
        return {
          projects: rescued,
          path: file,
          recovered: true,
          error:
            'The project list file was missing, so this list came from the backup beside it. ' +
            'It will be written back the next time the list changes.'
        }
      }
      return { projects: [], path: file }
    }
    // Locked, unreadable, a permissions change: anything but "not there".
    const recovered = await readBackup()
    return {
      projects: recovered ?? [],
      path: file,
      recovered: recovered !== null,
      error: `Could not read the project list (${code ?? (e as Error).message}).`
    }
  }

  const projects = parse(raw)
  if (projects) return { projects, path: file }

  // The file exists but is damaged -- a truncated write, or an interrupted
  // copy. Fall back to the backup rather than starting from nothing.
  const recovered = await readBackup()
  return {
    projects: recovered ?? [],
    path: file,
    recovered: recovered !== null,
    error:
      raw.trim() === ''
        ? 'The project list file is empty.'
        : 'The project list file could not be understood.'
  }
}

async function readBackup(): Promise<ProjectRef[] | null> {
  try {
    return parse(await fs.readFile(backupPath(), 'utf8'))
  } catch {
    return null
  }
}

/** The list alone, for callers that only need the happy path. */
export async function readRegistry(): Promise<ProjectRef[]> {
  return (await readRegistryDetailed()).projects
}

/**
 * Replace the registry without ever leaving it half-written.
 *
 * The previous version is kept as .bak first, then the new one is written to a
 * temporary file and renamed over the old. A rename within one directory is
 * atomic, so a crash or a pulled plug leaves either the old file or the new
 * one -- never a truncated file that reads as no projects at all.
 */
export async function writeRegistry(projects: ProjectRef[]): Promise<void> {
  const file = registryPath()
  await fs.mkdir(path.dirname(file), { recursive: true })

  try {
    await fs.copyFile(file, backupPath())
  } catch {
    // No previous file, or it cannot be copied; the write below still stands.
  }

  const temp = file + '.tmp'
  await fs.writeFile(temp, JSON.stringify({ version: 1, projects }, null, 2), 'utf8')
  await fs.rename(temp, file)
}

/**
 * Add or update one project.
 *
 * If the existing list could not be read, this refuses rather than writing a
 * list with one entry in it: that would turn a temporary read failure into the
 * permanent loss of every other project.
 */
export async function upsertProjectRef(ref: ProjectRef): Promise<ProjectRef[]> {
  const current = await readRegistryDetailed()
  if (current.error && !current.recovered) {
    throw new Error(
      `${current.error} Refusing to overwrite it and lose the projects it may hold. ` +
        `The file is at ${current.path}.`
    )
  }

  const next = current.projects.filter((p) => p.id !== ref.id)
  next.unshift(ref)
  await writeRegistry(next)
  return next
}

export async function removeProjectRef(id: string): Promise<ProjectRef[]> {
  const current = await readRegistryDetailed()
  if (current.error && !current.recovered) {
    throw new Error(`${current.error} The file is at ${current.path}.`)
  }
  const next = current.projects.filter((p) => p.id !== id)
  await writeRegistry(next)
  return next
}
