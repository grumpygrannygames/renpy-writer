import { promises as fs } from 'node:fs'
import * as path from 'node:path'

/**
 * Write a file so that it is never left half written, and so that two writes
 * of it at once cannot trip over each other.
 *
 * Writing in place empties the file first and fills it after, and anything
 * that stops the process in between -- quitting, a crash, a power cut --
 * leaves it at 0 bytes. So the content goes to a file beside it, and is
 * renamed over the original once it is all there. A rename within one folder
 * is all or nothing: an interruption leaves the old file or the new one,
 * never neither. Beside it rather than in a temp folder, because a rename
 * across drives is a copy.
 *
 * The file beside it has a name of its own every time. It used to be
 * `<file>.tmp`, shared by every write of that file, and two writes close
 * together -- two tabs saving, each refreshing the project list -- both wrote
 * into it; the first renamed it away and the second failed to find it, which
 * reached the writer as "Save failed: ENOENT ... projects.json.tmp".
 */
export async function writeFileAtomic(
  target: string,
  content: string,
  options: { mode?: number } = {}
): Promise<void> {
  await fs.mkdir(path.dirname(target), { recursive: true })
  const temp = `${target}.${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.tmp`
  try {
    await fs.writeFile(temp, content, { encoding: 'utf8', ...(options.mode ? { mode: options.mode } : {}) })
    await renameOver(temp, target)
  } catch (e) {
    await fs.rm(temp, { force: true }).catch(() => {})
    throw e
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
export async function renameOver(from: string, to: string): Promise<void> {
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

/**
 * Run read-change-write steps on one file one at a time.
 *
 * A safe write keeps the file whole, but two updates that both read it before
 * either writes still lose one of them: each writes the list it read plus its
 * own change. Queued, each one reads what the one before it wrote. A step that
 * fails does not hold up the ones behind it.
 */
export function oneAtATime(): <T>(step: () => Promise<T>) => Promise<T> {
  let last: Promise<unknown> = Promise.resolve()
  return <T>(step: () => Promise<T>): Promise<T> => {
    const run = last.then(step, step)
    last = run.catch(() => {})
    return run
  }
}
