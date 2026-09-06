import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import { randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'

const derive = promisify(scrypt) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number }
) => Promise<Buffer>

/**
 * Accounts.
 *
 * Passwords are never stored, only a scrypt hash of them. scrypt is in Node
 * itself, so this needs no dependency and nobody cloning the project has to
 * register an application with a third party to sign in.
 *
 * There is no public sign-up: an administrator makes accounts. For a project
 * with a writer and a proofreader that is the whole requirement, and it means
 * an exposed server cannot be filled with strangers.
 */

/**
 * Deliberately slow: about a tenth of a second per attempt, which is nothing
 * when signing in and a great deal when guessing.
 *
 * N=2^15 needs 128 * N * r bytes, which is exactly Node's default ceiling of
 * 32 MB, so the ceiling is raised rather than the cost lowered.
 */
const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 96 * 1024 * 1024 }
const KEY_LENGTH = 32

export type Role = 'admin' | 'writer' | 'proofreader' | 'viewer'

export interface User {
  id: string
  username: string
  role: Role
  createdAt: string
  /** Used to attribute commits. Optional; a local address stands in. */
  email?: string
}

interface StoredUser extends User {
  salt: string
  hash: string
}

export interface UserStore {
  count(): Promise<number>
  list(): Promise<User[]>
  create(input: { username: string; password: string; role: Role; email?: string }): Promise<User>
  /** The user, or null. The same null for "no such name" and "wrong password". */
  verify(username: string, password: string): Promise<User | null>
  byId(id: string): Promise<User | null>
  setPassword(id: string, password: string): Promise<void>
  remove(id: string): Promise<void>
}

async function hash(password: string, salt: Buffer): Promise<Buffer> {
  return derive(password, salt, KEY_LENGTH, SCRYPT)
}

/** Strip anything that must never leave this module. */
function publicUser(u: StoredUser): User {
  return { id: u.id, username: u.username, role: u.role, createdAt: u.createdAt, email: u.email }
}

export function createUserStore(dataDir: string): UserStore {
  const file = path.join(dataDir, 'users.json')

  const read = async (): Promise<StoredUser[]> => {
    try {
      const parsed = JSON.parse(await fs.readFile(file, 'utf8'))
      return Array.isArray(parsed.users) ? parsed.users : []
    } catch {
      return []
    }
  }

  const write = async (users: StoredUser[]): Promise<void> => {
    await fs.mkdir(path.dirname(file), { recursive: true })
    const temp = file + '.tmp'
    // 0600: nobody else on the machine needs to read password hashes.
    await fs.writeFile(temp, JSON.stringify({ version: 1, users }, null, 2), {
      encoding: 'utf8',
      mode: 0o600
    })
    await fs.rename(temp, file)
  }

  return {
    async count() {
      return (await read()).length
    },

    async list() {
      return (await read()).map(publicUser)
    },

    async create({ username, password, role, email }) {
      const name = username.trim().toLowerCase()
      if (!name) throw new Error('A username is required.')
      if (password.length < 12) {
        throw new Error('Use at least 12 characters. Length matters more than punctuation.')
      }

      const users = await read()
      if (users.some((u) => u.username === name)) {
        throw new Error(`There is already an account called ${name}.`)
      }

      const salt = randomBytes(16)
      const stored: StoredUser = {
        id: randomUUID(),
        username: name,
        role,
        email,
        createdAt: new Date().toISOString(),
        salt: salt.toString('base64'),
        hash: (await hash(password, salt)).toString('base64')
      }
      await write([...users, stored])
      return publicUser(stored)
    },

    async verify(username, password) {
      const name = username.trim().toLowerCase()
      const users = await read()
      const found = users.find((u) => u.username === name)

      // An unknown name still pays for a hash, so the time taken cannot be
      // used to work out which accounts exist.
      const salt = found ? Buffer.from(found.salt, 'base64') : randomBytes(16)
      const attempt = await hash(password, salt)
      if (!found) return null

      const expected = Buffer.from(found.hash, 'base64')
      if (attempt.length !== expected.length) return null
      if (!timingSafeEqual(attempt, expected)) return null
      return publicUser(found)
    },

    async byId(id) {
      const found = (await read()).find((u) => u.id === id)
      return found ? publicUser(found) : null
    },

    async setPassword(id, password) {
      if (password.length < 12) {
        throw new Error('Use at least 12 characters. Length matters more than punctuation.')
      }
      const users = await read()
      const found = users.find((u) => u.id === id)
      if (!found) throw new Error('No such account.')
      const salt = randomBytes(16)
      found.salt = salt.toString('base64')
      found.hash = (await hash(password, salt)).toString('base64')
      await write(users)
    },

    async remove(id) {
      const users = await read()
      const remaining = users.filter((u) => u.id !== id)
      if (remaining.length === users.length) throw new Error('No such account.')
      if (!remaining.some((u) => u.role === 'admin')) {
        throw new Error('That is the only administrator. Make another one first.')
      }
      await write(remaining)
    }
  }
}
