import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import type { DirEntry } from '@shared/types'
import type { WorkspaceProvider } from './WorkspaceProvider'

export class LocalWorkspaceProvider implements WorkspaceProvider {
  constructor(readonly root: string) {}

  /** Resolve a relative path, refusing anything that escapes the project root. */
  private abs(rel: string): string {
    const resolved = path.resolve(this.root, rel)
    const rootWithSep = this.root.endsWith(path.sep) ? this.root : this.root + path.sep
    if (resolved !== this.root && !resolved.startsWith(rootWithSep)) {
      throw new Error(`Path escapes project root: ${rel}`)
    }
    return resolved
  }

  async readText(rel: string): Promise<string> {
    return fs.readFile(this.abs(rel), 'utf8')
  }

  async writeText(rel: string, content: string): Promise<void> {
    const target = this.abs(rel)
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(target, content, 'utf8')
  }

  async exists(rel: string): Promise<boolean> {
    try {
      await fs.access(this.abs(rel))
      return true
    } catch {
      return false
    }
  }

  async list(rel: string): Promise<DirEntry[]> {
    const entries = await fs.readdir(this.abs(rel), { withFileTypes: true })
    return entries.map((e) => ({ name: e.name, isDirectory: e.isDirectory() }))
  }

  async ensureDir(rel: string): Promise<void> {
    await fs.mkdir(this.abs(rel), { recursive: true })
  }

  async remove(rel: string): Promise<void> {
    await fs.rm(this.abs(rel), { force: true })
  }
}
