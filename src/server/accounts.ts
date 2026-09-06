import * as path from 'node:path'
import { stdin, stdout } from 'node:process'
import { createUserStore, type Role } from './users'

/**
 * Making accounts, from a terminal on the server.
 *
 *   npm run account -- add <username> [--role writer] [--email you@example.com]
 *   npm run account -- list
 *   npm run account -- password <username>
 *
 * The password is typed at a prompt rather than passed as an argument, so it
 * does not end up in shell history or in the list of running processes, and
 * nothing is echoed while typing.
 */
const ROLES: Role[] = ['admin', 'writer', 'proofreader', 'viewer']

const CTRL_C = String.fromCharCode(3)
const DELETE = String.fromCharCode(127)

/**
 * Anything typed past the end of one answer, kept for the next prompt.
 *
 * A terminal delivers one keystroke at a time, but piped input arrives as a
 * single chunk holding every line at once. Without this the first prompt
 * swallows the second one's answer, and the two can never match.
 */
let pending = ''

/**
 * Read a line without showing it.
 *
 * Raw mode is the supported way: the terminal stops echoing and stops
 * interpreting keys, so every character arrives here and none appear on
 * screen. Backspace and Ctrl+C then have to be handled by hand, which is the
 * price of the terminal no longer doing it.
 *
 * Piped input has no terminal to put into raw mode, and nothing to hide, so
 * the line is simply read.
 */
function askHidden(prompt: string): Promise<string> {
  stdout.write(prompt)

  return new Promise<string>((resolve, reject) => {
    let value = ''
    const interactive = Boolean(stdin.isTTY)

    const cleanup = (): void => {
      stdin.off('data', onData)
      if (interactive) stdin.setRawMode(false)
      stdin.pause()
    }

    /** True once a whole answer has been read. */
    const consume = (text: string): boolean => {
      for (let i = 0; i < text.length; i++) {
        const ch = text[i]

        if (ch === '\r' || ch === '\n') {
          // Whatever followed the newline belongs to the next prompt.
          let rest = text.slice(i + 1)
          if (ch === '\r' && rest.startsWith('\n')) rest = rest.slice(1)
          pending = rest
          stdout.write('\n')
          resolve(value)
          return true
        }

        if (ch === CTRL_C) {
          pending = ''
          stdout.write('\n')
          reject(new Error('Cancelled.'))
          return true
        }

        // Backspace and delete, so a typo can be corrected blind.
        if (ch === DELETE || ch === '\b') {
          value = value.slice(0, -1)
          continue
        }

        // Ignore other control characters rather than storing them.
        if (ch < ' ') continue
        value += ch
      }
      return false
    }

    const onData = (chunk: Buffer | string): void => {
      if (consume(chunk.toString('utf8'))) cleanup()
    }

    // Anything already read past the previous answer comes first.
    if (pending) {
      const carried = pending
      pending = ''
      if (consume(carried)) return
    }

    if (interactive) stdin.setRawMode(true)
    stdin.resume()
    stdin.on('data', onData)
    stdin.once('end', () => {
      cleanup()
      resolve(value)
    })
  })
}

const arg = (name: string, fallback?: string): string | undefined => {
  const at = process.argv.indexOf('--' + name)
  return at === -1 ? fallback : process.argv[at + 1]
}

/**
 * The command and its subject, wherever they sit among the flags.
 *
 * Read positionally this would depend on argument order, and getting that
 * order wrong printed the usage line -- which reads as "you typed a command I
 * do not have" when what happened was "you put --data first". Every flag here
 * takes a value, so a flag and the token after it are skipped together.
 */
function positional(): string[] {
  const rest: string[] = []
  const argv = process.argv.slice(2)
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) i++
    else rest.push(argv[i])
  }
  return rest
}

async function main(): Promise<void> {
  const [command, subject] = positional()
  const users = createUserStore(path.resolve(arg('data', '.server-data')!))

  if (command === 'list') {
    const all = await users.list()
    if (all.length === 0) console.log('No accounts yet.')
    for (const u of all) console.log(`${u.username}\t${u.role}\tsince ${u.createdAt.slice(0, 10)}`)
    return
  }

  if (command === 'add') {
    if (!subject) {
      throw new Error('Usage: account add <username> [--role writer] [--email you@example.com]')
    }
    const role = (arg('role', 'writer') ?? 'writer') as Role
    if (!ROLES.includes(role)) throw new Error(`Role must be one of: ${ROLES.join(', ')}`)

    // Worth setting to the address the person uses on the git host: commits
    // this account makes carry it, and that is what decides whether the host
    // shows the work as theirs or as a stranger's. Left out, it falls back to
    // a local-only address that no host will recognise.
    const email = arg('email')

    const password = await askHidden(`Password for ${subject}: `)
    const again = await askHidden('Again: ')
    if (password !== again) throw new Error('Those did not match. Nothing was created.')

    const created = await users.create({ username: subject, password, role, email })
    console.log(`Created ${created.username} as ${created.role}.`)
    return
  }

  if (command === 'password') {
    if (!subject) throw new Error('Usage: account password <username>')
    const found = (await users.list()).find((u) => u.username === subject.toLowerCase())
    if (!found) throw new Error(`No account called ${subject}.`)

    const password = await askHidden(`New password for ${found.username}: `)
    const again = await askHidden('Again: ')
    if (password !== again) throw new Error('Those did not match. Nothing was changed.')

    await users.setPassword(found.id, password)
    console.log('Changed.')
    return
  }

  // Say what was not understood. A bare usage line leaves somebody rereading
  // their spelling when the problem was somewhere else entirely.
  if (command) console.log(`Not a command: ${command}`)
  console.log('Usage: account add <username> [--role writer] [--email you@example.com]')
  console.log('       account list')
  console.log('       account password <username>')
  console.log('Anything may take --data <folder>, before or after the command.')
}

try {
  await main()
  process.exit(0)
} catch (e) {
  console.error((e as Error).message)
  // Non-zero, so a script calling this can tell that it failed.
  process.exit(1)
}
