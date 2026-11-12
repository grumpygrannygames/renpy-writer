import { RwHost } from '../native'

/**
 * `spawn`, for the one program a phone has: the git bundled with the app.
 *
 * The shared code talks to processes the Node way -- write to stdin, listen
 * for data and close -- so this keeps that shape and runs the whole thing as
 * one call to the Java side once stdin is finished. Anything other than git
 * fails the way a missing program does on a computer, which the shared code
 * already turns into a plain message.
 */

type Listener = (...args: unknown[]) => void

class Emitter {
  private listeners = new Map<string, Listener[]>()
  on(event: string, listener: Listener): this {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener])
    return this
  }
  once(event: string, listener: Listener): this {
    const wrapped: Listener = (...args) => {
      this.off(event, wrapped)
      listener(...args)
    }
    return this.on(event, wrapped)
  }
  off(event: string, listener: Listener): this {
    this.listeners.set(event, (this.listeners.get(event) ?? []).filter((l) => l !== listener))
    return this
  }
  emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(...args)
  }
}

class Child extends Emitter {
  stdout = new Emitter()
  stderr = new Emitter()
  stdin: { write(chunk: string): void; end(chunk?: string): void }
  pid = 0
  killed = false

  constructor(command: string, args: string[], cwd: string) {
    super()
    let input = ''
    let ended = false
    this.stdin = {
      write: (chunk: string) => {
        input += String(chunk)
      },
      end: (chunk?: string) => {
        if (ended) return
        ended = true
        if (chunk !== undefined) input += String(chunk)
        void this.run(command, args, cwd, input)
      }
    }
  }

  kill(): boolean {
    this.killed = true
    return true
  }

  private async run(command: string, args: string[], cwd: string, input: string): Promise<void> {
    // Let the caller finish attaching its listeners first, as Node would.
    await Promise.resolve()
    if (command !== 'git') {
      const missing = new Error(`spawn ${command} ENOENT`) as Error & { code: string }
      missing.code = 'ENOENT'
      this.emit('error', missing)
      return
    }
    try {
      const result = await RwHost.exec({ args, cwd, stdin: input })
      if (result.stdout) this.stdout.emit('data', result.stdout)
      if (result.stderr) this.stderr.emit('data', result.stderr)
      this.emit('exit', result.code)
      this.emit('close', result.code)
    } catch (e) {
      this.emit('error', e instanceof Error ? e : new Error(String(e)))
    }
  }
}

export function spawn(
  command: string,
  args: string[] = [],
  options: { cwd?: string; shell?: boolean } = {}
): Child {
  // `shell: true` hands one quoted command line over; only git is ever run,
  // and never that way, so the program is whatever comes first.
  const program = options.shell ? command.replace(/^"|"$/g, '').split(/[\\/]/).pop() ?? command : command
  return new Child(program, args, options.cwd ?? '/')
}

export default { spawn }
