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
    const target = this.abs(rel)
    await fs.mkdir(path.dirname(target), { recursive: true })
    // Unique, because two saves of one file can overlap.
    const temp = `${target}.${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.tmp`
    try {
      await fs.writeFile(temp, content, 'utf8')
      await renameOver(temp, target)
    } catch (e) {
      await fs.rm(temp, { force: true }).catch(() => {})
      throw e
    }
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

/**
 * Rename over an existing file, riding out Windows holding it for a moment.
 *
 * On Windows a rename onto a file fails while anything else has that file
 * open -- a virus scanner reading what was just written, the git index, an
 * editor -- and those holds last milliseconds. Giving up at the first refusal
 * would turn a safe write into a failed one, so it tries a few more times.
 */
async function renameOver(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.rename(from, to)
      return
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      const held = code === 'EPERM' || code === 'EBUSY' || code === 'EACCES'
      if (!held || attempt >= 6) throw e
      await new Promise((r) => setTimeout(r, 20 * 2 ** attempt))
    }
  }
}
