import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import type { DirEntry } from '@shared/types'
import type { WorkspaceProvider } from './WorkspaceProvider'
import { writeFileAtomic } from '../atomicFile'

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

  /**
   * Write a file so that it is never left half written.
   *
   * Writing in place empties the file first and fills it after, and anything
   * that stops the process in between -- quitting, a crash, a power cut --
   * leaves it at 0 bytes. That is not a theory: quitting mid-save emptied all
   * three notes files of a real project, the next launch read the empty file
   * as "no characters", and a note edit wrote that back and committed it.
   *
   * So the content goes to a file beside it, and is renamed over the original
   * once it is all there. A rename within one folder is all or nothing: an
   * interruption leaves the old file or the new one, never neither. Beside it
   * rather than in a temp folder, because a rename across drives is a copy.
   */
  async writeText(rel: string, content: string): Promise<void> {
    await writeFileAtomic(this.abs(rel), content)
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
