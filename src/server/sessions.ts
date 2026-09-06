import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import { randomBytes } from 'node:crypto'

/**
 * Signed-in sessions.
 *
 * Kept in a file rather than in memory so that restarting the server -- a
 * deploy, a reboot -- does not sign everybody out. The identifier is 256 bits
 * of randomness, which is what makes it unguessable; there is nothing else in
 * the cookie, so nothing in it can be tampered with to mean something else.
 */

const LIFETIME_MS = 30 * 24 * 60 * 60 * 1000

export interface Session {
  id: string
  userId: string
  createdAt: number
  expiresAt: number
}

export interface SessionStore {
  create(userId: string): Promise<Session>
  get(id: string): Promise<Session | null>
  destroy(id: string): Promise<void>
  destroyAllFor(userId: string): Promise<void>
}

export function createSessionStore(dataDir: string): SessionStore {
  const file = path.join(dataDir, 'sessions.json')

  const read = async (): Promise<Session[]> => {
    try {
      const parsed = JSON.parse(await fs.readFile(file, 'utf8'))
      const all: Session[] = Array.isArray(parsed.sessions) ? parsed.sessions : []
      // Expired sessions are dropped whenever the file is touched, so the
      // file cannot grow without bound and an old cookie cannot come back.
      const now = Date.now()
      return all.filter((s) => s.expiresAt > now)
    } catch {
      return []
    }
  }

  const write = async (sessions: Session[]): Promise<void> => {
    await fs.mkdir(path.dirname(file), { recursive: true })
    const temp = file + '.tmp'
    await fs.writeFile(temp, JSON.stringify({ version: 1, sessions }, null, 2), {
      encoding: 'utf8',
      mode: 0o600
    })
    await fs.rename(temp, file)
  }

  return {
    async create(userId) {
      const session: Session = {
        id: randomBytes(32).toString('base64url'),
        userId,
        createdAt: Date.now(),
        expiresAt: Date.now() + LIFETIME_MS
      }
      await write([...(await read()), session])
      return session
    },

    async get(id) {
      if (!id) return null
      return (await read()).find((s) => s.id === id) ?? null
    },

    async destroy(id) {
      await write((await read()).filter((s) => s.id !== id))
    },

    async destroyAllFor(userId) {
      await write((await read()).filter((s) => s.userId !== userId))
    }
  }
}
