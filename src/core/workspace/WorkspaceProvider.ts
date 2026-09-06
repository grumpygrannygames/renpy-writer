import type { DirEntry } from '@shared/types'

/**
 * All filesystem access goes through this interface so the renderer never
 * talks to `fs` directly. The local implementation reads the Ren'Py folder on
 * disk; a future HTTP implementation can back the same UI with a remote
 * workspace without any renderer changes.
 *
 * Every path is POSIX-style and relative to the project root.
 */
export interface WorkspaceProvider {
  readonly root: string
  readText(rel: string): Promise<string>
  writeText(rel: string, content: string): Promise<void>
  exists(rel: string): Promise<boolean>
  list(rel: string): Promise<DirEntry[]>
  ensureDir(rel: string): Promise<void>
  remove(rel: string): Promise<void>
}
