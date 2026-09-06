import type { IncomingMessage } from 'node:http'
import { IPC } from '@shared/api'
import type { Role, User } from './users'

/**
 * Who is asking, and whether they may.
 *
 * Three separate concerns live here, and it is worth naming them apart:
 * identifying the caller (the session cookie), confirming the request really
 * came from this app rather than another page (the origin check), and deciding
 * whether that person is allowed to do this particular thing (the role).
 */

export const COOKIE_NAME = 'rpw_session'

export function readCookie(req: IncomingMessage, name: string): string | null {
  const header = req.headers.cookie
  if (!header) return null
  for (const part of header.split(';')) {
    const at = part.indexOf('=')
    if (at === -1) continue
    if (part.slice(0, at).trim() === name) return decodeURIComponent(part.slice(at + 1).trim())
  }
  return null
}

export function sessionCookie(id: string, secure: boolean): string {
  return [
    `${COOKIE_NAME}=${encodeURIComponent(id)}`,
    'Path=/',
    // Not readable from script, so a cross-site script cannot lift it.
    'HttpOnly',
    // Never sent on a request another site started, which is most of what
    // makes cross-site request forgery possible in the first place.
    'SameSite=Strict',
    `Max-Age=${30 * 24 * 60 * 60}`,
    ...(secure ? ['Secure'] : [])
  ].join('; ')
}

export function clearedCookie(secure: boolean): string {
  return [
    `${COOKIE_NAME}=`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    'Max-Age=0',
    ...(secure ? ['Secure'] : [])
  ].join('; ')
}

/**
 * Refuse anything a different site started.
 *
 * SameSite=Strict already stops the cookie travelling, so this is a second
 * line rather than the only one -- but it costs nothing and it catches a
 * browser that does not honour the first.
 */
export function originAllowed(req: IncomingMessage): boolean {
  const origin = req.headers.origin
  // Same-origin fetches from some browsers omit Origin entirely on POST; the
  // cookie rules still apply, so an absent header is not itself suspicious.
  if (!origin) return true
  const host = req.headers.host
  if (!host) return false
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

/**
 * Operations that change something.
 *
 * Listed explicitly rather than guessed from the name, because getting this
 * wrong in the permissive direction is how a viewer ends up rewriting a
 * script. Anything not named here is a read.
 */
const WRITES: ReadonlySet<string> = new Set([
  IPC.createProject,
  IPC.removeProject,
  IPC.updateSettings,
  IPC.renameCharacter,
  IPC.writeReference,
  IPC.createEpisode,
  IPC.reorderEpisodes,
  IPC.setEpisodeStatus,
  IPC.moveBeat,
  IPC.createBeat,
  IPC.updateBeat,
  IPC.removeBeat,
  IPC.runScriptPass,
  IPC.setEpisodeRenders,
  IPC.convertRenders,
  IPC.writeEpisode,
  IPC.gitPull,
  IPC.gitCommit,
  IPC.gitPush,
  // Settling a disagreement writes the chosen lines into the script, which is
  // as much a change as typing them would have been.
  IPC.gitResolvePull
])

export function isWrite(channel: string): boolean {
  return WRITES.has(channel)
}

const MAY_WRITE: ReadonlySet<Role> = new Set<Role>(['admin', 'writer'])

/**
 * Whether this person may perform this operation.
 *
 * A proofreader cannot write directly yet. Once suggestions exist their edits
 * become proposals for an administrator to accept, which is a different thing
 * from being refused -- until then, refusing is the honest answer rather than
 * letting edits through and calling it review.
 */
export function mayPerform(user: User, channel: string): boolean {
  if (!isWrite(channel)) return true
  return MAY_WRITE.has(user.role)
}

export function refusalFor(user: User, channel: string): string {
  if (user.role === 'proofreader') {
    return (
      'Proofreaders cannot change the project directly yet. Suggestions that an administrator ' +
      'can accept or turn down are the next thing being built.'
    )
  }
  return `A ${user.role} cannot do that.`
}

/**
 * Did this request actually arrive over HTTPS?
 *
 * Behind a reverse proxy the connection to this process is plain, and only the
 * proxy's header says what the browser used. Trusting that header is only
 * sound because nothing but the proxy can reach the port.
 */
export function arrivedOverHttps(req: IncomingMessage): boolean {
  if ((req.socket as { encrypted?: boolean }).encrypted) return true
  const forwarded = req.headers['x-forwarded-proto']
  const first = Array.isArray(forwarded) ? forwarded[0] : forwarded
  return (first ?? '').split(',')[0].trim() === 'https'
}

/**
 * Slow down guessing.
 *
 * Counted per username and per address, so one account being attacked cannot
 * lock out everybody, and one address trying many accounts is still stopped.
 */
export function createAttemptLimiter(options?: { max?: number; windowMs?: number }) {
  const max = options?.max ?? 10
  const windowMs = options?.windowMs ?? 15 * 60 * 1000
  const attempts = new Map<string, { count: number; first: number }>()

  return {
    check(key: string): { allowed: boolean; retryInSeconds?: number } {
      const now = Date.now()
      const record = attempts.get(key)
      if (!record || now - record.first > windowMs) return { allowed: true }
      if (record.count < max) return { allowed: true }
      return {
        allowed: false,
        retryInSeconds: Math.ceil((record.first + windowMs - now) / 1000)
      }
    },
    fail(key: string): void {
      const now = Date.now()
      const record = attempts.get(key)
      if (!record || now - record.first > windowMs) attempts.set(key, { count: 1, first: now })
      else record.count++
    },
    succeed(key: string): void {
      attempts.delete(key)
    }
  }
}
