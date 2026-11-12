/**
 * The Java side of the Android app, played by Node, for testing on a computer.
 *
 * Each method does what RwHostPlugin.java does, with the same error codes, so
 * the shims and everything above them run exactly as they would on a phone --
 * except that git is this computer's rather than the bundled one.
 *
 * Node's own modules are reached with getBuiltinModule, because in this test
 * bundle `fs` and `child_process` are the phone's shims.
 */
const fs = process.getBuiltinModule('fs') as typeof import('node:fs')
const cp = process.getBuiltinModule('child_process') as typeof import('node:child_process')
const nodePath = process.getBuiltinModule('path') as typeof import('node:path')

function fail(code: string, message: string): never {
  const e = new Error(message) as Error & { code: string }
  e.code = code
  throw e
}

export const where = { files: '', cache: '' }

/**
 * A phone-shaped path, as this computer's git needs to see it. Node on Windows
 * reads /Users/... as the current drive, but Git for Windows reads it as a
 * folder inside its own installation, so arguments get their drive back.
 */
const DRIVE = process.platform === 'win32' ? process.cwd().slice(0, 2) : ''
export function forGit(arg: string): string {
  if (!DRIVE) return arg
  return arg.replace(/^(file:\/\/)?\/(?=[A-Za-z])/, (_m, scheme: string | undefined) => `${scheme ?? ''}${scheme ? '/' : ''}${DRIVE}/`)
}

export async function start(): Promise<void> {
  if (!where.files) throw new Error('Set where.files before starting.')
}

export const RwHost = {
  async paths() {
    return { ...where }
  },
  async readFile({ path, encoding }: { path: string; encoding: string }) {
    if (!fs.existsSync(path)) fail('ENOENT', 'no such file or directory')
    if (fs.statSync(path).isDirectory()) fail('EISDIR', 'illegal operation on a directory')
    const bytes = fs.readFileSync(path)
    return { data: encoding === 'base64' ? bytes.toString('base64') : bytes.toString('utf8') }
  },
  async writeFile({ path, data, encoding }: { path: string; data: string; encoding: string }) {
    if (!fs.existsSync(nodePath.dirname(path))) fail('ENOENT', 'no such file or directory')
    fs.writeFileSync(path, encoding === 'base64' ? Buffer.from(data, 'base64') : data)
  },
  async mkdir({ path, recursive }: { path: string; recursive: boolean }) {
    if (fs.existsSync(path)) {
      if (recursive) return
      fail('EEXIST', 'file already exists')
    }
    try {
      fs.mkdirSync(path, { recursive })
    } catch {
      fail('ENOENT', 'no such file or directory')
    }
  },
  async readdir({ path }: { path: string }) {
    if (!fs.existsSync(path)) fail('ENOENT', 'no such file or directory')
    if (!fs.statSync(path).isDirectory()) fail('ENOTDIR', 'not a directory')
    return {
      entries: fs.readdirSync(path, { withFileTypes: true }).map((e) => ({
        name: e.name,
        isDirectory: e.isDirectory()
      }))
    }
  },
  async stat({ path }: { path: string }) {
    if (!fs.existsSync(path)) fail('ENOENT', 'no such file or directory')
    const s = fs.statSync(path)
    return { isFile: s.isFile(), isDirectory: s.isDirectory(), size: s.size, mtimeMs: s.mtimeMs }
  },
  async rename({ from, to }: { from: string; to: string }) {
    if (!fs.existsSync(from)) fail('ENOENT', 'no such file or directory')
    fs.renameSync(from, to)
  },
  async rm({ path, recursive, force }: { path: string; recursive: boolean; force: boolean }) {
    if (!fs.existsSync(path)) {
      if (force) return
      fail('ENOENT', 'no such file or directory')
    }
    if (fs.statSync(path).isDirectory() && !recursive) fail('EISDIR', 'is a directory')
    fs.rmSync(path, { recursive: true, force: true })
  },
  async utimes({ path, mtimeMs }: { path: string; mtimeMs: number }) {
    if (!fs.existsSync(path)) fail('ENOENT', 'no such file or directory')
    fs.utimesSync(path, new Date(mtimeMs), new Date(mtimeMs))
  },
  async exec({ args, cwd, stdin }: { args: string[]; cwd: string; stdin?: string }) {
    const r = cp.spawnSync('git', args.map(forGit), {
      cwd,
      input: stdin ?? '',
      encoding: 'utf8',
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' }
    })
    if (r.error) fail('ENOENT', 'git could not be started: ' + r.error.message)
    return { code: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
  }
}
