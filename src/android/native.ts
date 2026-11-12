import { registerPlugin } from '@capacitor/core'

/**
 * The Java side of the Android app: files, and running git.
 *
 * Everything the shared code asks of Node -- read a file, list a folder, run
 * a program -- arrives here on a phone. The calls are deliberately few and
 * plain, so the Java that answers them can be checked by reading it.
 */
export interface RwHostPlugin {
  /** Where the app may keep things. Asked once, at start. */
  paths(): Promise<{ files: string; cache: string }>

  readFile(o: { path: string; encoding: 'utf8' | 'base64' }): Promise<{ data: string }>
  writeFile(o: { path: string; data: string; encoding: 'utf8' | 'base64' }): Promise<void>
  mkdir(o: { path: string; recursive: boolean }): Promise<void>
  readdir(o: { path: string }): Promise<{ entries: { name: string; isDirectory: boolean }[] }>
  stat(o: { path: string }): Promise<{ isFile: boolean; isDirectory: boolean; size: number; mtimeMs: number }>
  rename(o: { from: string; to: string }): Promise<void>
  rm(o: { path: string; recursive: boolean; force: boolean }): Promise<void>
  utimes(o: { path: string; mtimeMs: number }): Promise<void>

  /** Run the bundled git, the only program there is. */
  exec(o: {
    args: string[]
    cwd: string
    stdin?: string
  }): Promise<{ code: number; stdout: string; stderr: string }>
}

export const RwHost = registerPlugin<RwHostPlugin>('RwHost')

/** Filled in by start(), before anything shared runs. */
export const where = { files: '', cache: '' }

export async function start(): Promise<void> {
  Object.assign(where, await RwHost.paths())
}
