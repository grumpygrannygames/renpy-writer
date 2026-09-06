import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import type { ProjectListing } from '@shared/api'
import type { ProjectRef } from '@shared/types'
import type { HostServices } from '@core/handlers'

/**
 * The server's list of known projects.
 *
 * Deliberately the same shape and the same care as the desktop's: a read that
 * fails is reported rather than reported as empty, and a write never truncates
 * the only copy. When there are accounts, this becomes a table keyed by who is
 * asking; the interface above it does not change.
 */
export function createFileRegistry(dataDir: string): HostServices['registry'] {
  const file = path.join(dataDir, 'projects.json')
  const backup = file + '.bak'

  const parse = (raw: string): ProjectRef[] | null => {
    try {
      const parsed = JSON.parse(raw)
      return Array.isArray(parsed.projects) ? parsed.projects : null
    } catch {
      return null
    }
  }

  const read = async (): Promise<ProjectListing> => {
    let raw: string
    try {
      raw = await fs.readFile(file, 'utf8')
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { projects: [], path: file }
      return { projects: [], path: file, error: `Could not read the project list: ${(e as Error).message}` }
    }
    const projects = parse(raw)
    if (projects) return { projects, path: file }

    const recovered = await fs.readFile(backup, 'utf8').then(parse).catch(() => null)
    return {
      projects: recovered ?? [],
      path: file,
      recovered: recovered !== null,
      error: 'The project list file could not be understood.'
    }
  }

  const write = async (projects: ProjectRef[]): Promise<void> => {
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.copyFile(file, backup).catch(() => {})
    const temp = file + '.tmp'
    await fs.writeFile(temp, JSON.stringify({ version: 1, projects }, null, 2), 'utf8')
    await fs.rename(temp, file)
  }

  const guard = (listing: ProjectListing): void => {
    if (listing.error && !listing.recovered) {
      throw new Error(`${listing.error} Refusing to overwrite it. The file is at ${listing.path}.`)
    }
  }

  return {
    read,
    async upsert(ref) {
      const current = await read()
      guard(current)
      const next = current.projects.filter((p) => p.id !== ref.id)
      next.unshift(ref)
      await write(next)
      return next
    },
    async remove(id) {
      const current = await read()
      guard(current)
      const next = current.projects.filter((p) => p.id !== id)
      await write(next)
      return next
    }
  }
}
