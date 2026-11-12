import { RwHost } from '../native'

/**
 * `node:fs`, as much of it as the shared code uses, answered by the phone.
 *
 * Errors keep Node's shape -- an `Error` with a `code` such as ENOENT --
 * because the shared code decides what to do from that code: a notes file
 * that is missing is a fresh project, one that will not read is a problem.
 */

interface Dirent {
  name: string
  isDirectory(): boolean
  isFile(): boolean
}

interface Stats {
  size: number
  mtimeMs: number
  mtime: Date
  isDirectory(): boolean
  isFile(): boolean
}

function asNodeError(e: unknown, op: string, path: string): Error {
  const code = (e as { code?: string })?.code
  const message = (e as { message?: string })?.message ?? String(e)
  const err = new Error(`${code ?? 'EIO'}: ${message}, ${op} '${path}'`) as Error & {
    code?: string
    path?: string
  }
  err.code = code && /^E[A-Z]+$/.test(code) ? code : 'EIO'
  err.path = path
  return err
}

async function call<T>(op: string, path: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (e) {
    throw asNodeError(e, op, path)
  }
}

function encodingOf(options: unknown): string | null {
  if (typeof options === 'string') return options
  if (options && typeof options === 'object' && 'encoding' in options) {
    return ((options as { encoding?: string }).encoding ?? null) as string | null
  }
  return null
}

function fromBase64(data: string): Uint8Array {
  const raw = atob(data)
  const out = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i)
  return out
}

function toBase64(bytes: Uint8Array): string {
  let raw = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    raw += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return btoa(raw)
}

export const promises = {
  async readFile(path: string, options?: unknown): Promise<string | Uint8Array> {
    const encoding = encodingOf(options)
    if (encoding) {
      return call('open', path, async () => (await RwHost.readFile({ path, encoding: 'utf8' })).data)
    }
    const { data } = await call('open', path, () => RwHost.readFile({ path, encoding: 'base64' }))
    return fromBase64(data)
  },

  async writeFile(path: string, data: string | Uint8Array, _options?: unknown): Promise<void> {
    if (typeof data === 'string') {
      return call('open', path, () => RwHost.writeFile({ path, data, encoding: 'utf8' }))
    }
    return call('open', path, () =>
      RwHost.writeFile({ path, data: toBase64(data), encoding: 'base64' })
    )
  },

  async mkdir(path: string, options?: { recursive?: boolean }): Promise<void> {
    return call('mkdir', path, () => RwHost.mkdir({ path, recursive: !!options?.recursive }))
  },

  async readdir(path: string, options?: { withFileTypes?: boolean }): Promise<string[] | Dirent[]> {
    const { entries } = await call('scandir', path, () => RwHost.readdir({ path }))
    if (!options?.withFileTypes) return entries.map((e) => e.name)
    return entries.map((e) => ({
      name: e.name,
      isDirectory: () => e.isDirectory,
      isFile: () => !e.isDirectory
    }))
  },

  async stat(path: string): Promise<Stats> {
    const s = await call('stat', path, () => RwHost.stat({ path }))
    return {
      size: s.size,
      mtimeMs: s.mtimeMs,
      mtime: new Date(s.mtimeMs),
      isDirectory: () => s.isDirectory,
      isFile: () => s.isFile
    }
  },

  async access(path: string): Promise<void> {
    await call('access', path, () => RwHost.stat({ path }))
  },

  async rename(from: string, to: string): Promise<void> {
    return call('rename', from, () => RwHost.rename({ from, to }))
  },

  async rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void> {
    return call('rm', path, () =>
      RwHost.rm({ path, recursive: !!options?.recursive, force: !!options?.force })
    )
  },

  async utimes(path: string, _atime: unknown, mtime: Date | number): Promise<void> {
    const ms = typeof mtime === 'number' ? mtime * 1000 : mtime.getTime()
    return call('utime', path, () => RwHost.utimes({ path, mtimeMs: ms }))
  },

  async mkdtemp(prefix: string): Promise<string> {
    const path = `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
    await call('mkdtemp', path, () => RwHost.mkdir({ path, recursive: true }))
    return path
  },

  async copyFile(from: string, to: string): Promise<void> {
    const { data } = await call('copyfile', from, () => RwHost.readFile({ path: from, encoding: 'base64' }))
    await call('copyfile', to, () => RwHost.writeFile({ path: to, data, encoding: 'base64' }))
  }
}

export default { promises }
