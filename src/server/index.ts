import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import { registerHandlers, type HostServices } from '@core/handlers'
import { useSettingsDir } from '@core/machine'
import { createFileRegistry } from './registry'
import { LocalWorkspaceProvider } from '@core/workspace/LocalWorkspaceProvider'
import { readSidecarProject } from '@core/projects/sidecar'
import { createMachineStore } from './machine'
import { createUserStore, type User } from './users'
import { createSessionStore } from './sessions'
import { authorFor, currentUser as callerOfThisRequest, runAsUser } from './context'
import { pull as gitPull } from '@core/git'
import {
  COOKIE_NAME,
  arrivedOverHttps,
  clearedCookie,
  createAttemptLimiter,
  mayPerform,
  originAllowed,
  readCookie,
  refusalFor,
  sessionCookie
} from './auth'

/**
 * The same operations as the desktop, reached over HTTP instead of IPC.
 *
 * Nothing here decides what anything does: every route dispatches into the one
 * handler set in core. What this file supplies is only what a server answers
 * differently -- there is nobody at the keyboard to pick a folder, the lists
 * live wherever the server was told to keep them, and there is no Chromium, so
 * no built-in image encoder.
 *
 * Every call must carry a session, and the session says who is calling and
 * what they are allowed to do. Listening beyond the loopback address is
 * refused until at least one account exists, so a server can never be exposed
 * before there is anything to sign in as.
 */

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2'
}

export interface ServerOptions {
  /** Where per-installation lists are kept. */
  dataDir: string
  /** Built renderer to serve. Omit to run the API alone. */
  webRoot?: string
  /**
   * Project folders this server is responsible for. Nothing outside this list
   * can be opened, so it is the whole of what the app can reach on disk.
   */
  projects?: string[]
  port?: number
  /**
   * Bind address. Anything but loopback needs an account to exist first, and
   * has to be asked for deliberately.
   */
  host?: string
  /**
   * Allow a non-loopback bind. Reachable from a network means reachable by
   * anyone who can route to it, so this is never the default.
   */
  allowNetwork?: boolean
  /**
   * Set the Secure flag on the session cookie. Defaults to on for anything
   * but loopback, because a session cookie sent in the clear can be copied by
   * anyone on the path. Turning it off is a deliberate choice for a trusted
   * private network.
   */
  secureCookies?: boolean
}

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost'])

export interface RunningServer {
  port: number
  /** Whether session cookies are marked Secure, as actually resolved. */
  secureCookies: boolean
  close(): Promise<void>
}

export async function startServer(options: ServerOptions): Promise<RunningServer> {
  const host = options.host ?? '127.0.0.1'

  await fs.mkdir(options.dataDir, { recursive: true })
  useSettingsDir(options.dataDir)

  const users = createUserStore(options.dataDir)
  const sessions = createSessionStore(options.dataDir)

  if (!LOOPBACK.has(host)) {
    if (!options.allowNetwork) {
      throw new Error(
        `Refusing to listen on ${host} without --allow-network. Being reachable from a network ` +
          'is a decision, not a default.'
      )
    }
    if ((await users.count()) === 0) {
      throw new Error(
        `Refusing to listen on ${host} with no accounts. Anyone who could reach it would find ` +
          'a server nobody can sign in to and everybody can read. Create an account first.'
      )
    }
  }

  // The operator's list, registered before anything can ask for it.
  const registry = createFileRegistry(options.dataDir)
  for (const projectPath of options.projects ?? []) {
    const resolved = path.resolve(projectPath)
    const sidecar = await readSidecarProject(new LocalWorkspaceProvider(resolved))
    if (!sidecar) {
      throw new Error(
        `${resolved} is not a Ren'Py Writer project: it has no .renpywriter folder. Open it ` +
          'once on a desktop, commit that folder, and pull it here.'
      )
    }
    await registry.upsert({
      id: sidecar.id,
      name: sidecar.name,
      renpyRoot: resolved,
      lastOpenedAt: new Date().toISOString()
    })
  }

  const limiter = createAttemptLimiter()
  const secure = options.secureCookies ?? !LOOPBACK.has(host)

  const services: HostServices = {
    // Nobody is standing at this machine to choose a folder.
    async pickFolder() {
      return null
    },
    registry,
    machine: createMachineStore(),
    /** The signed-in caller, so commits are attributed to a person. */
    async currentAuthor() {
      const caller = callerOfThisRequest()
      return caller ? authorFor(caller) : null
    },

    /**
     * Bring the checkout up to date before serving a project.
     *
     * This machine's copy is shared and nobody is sitting at it to press Sync,
     * so a phone would otherwise be shown whatever was here when the server
     * last happened to fetch. A failure is not fatal: being offline or having
     * diverged is a reason to serve what we have, not to refuse.
     */
    async beforeOpenProject(renpyRoot: string) {
      const result = await gitPull(renpyRoot)
      if (!result.ok) console.log(`[project ${renpyRoot}] ${result.message}`)
    },

    // No builtinEncoder: that one is Chromium's, and this is plain Node.
    capabilities: {
      // Nobody is here to answer a folder dialog.
      folderPicker: false,
      // Renders live in a Blender folder on somebody's desktop, and there is
      // no encoder here. Supporting this would mean reading a remote folder
      // and converting server-side, which is a different feature, not a
      // setting.
      renderSync: false,
      // The clone this serves is text only: 3 MB of scripts rather than 2 GB
      // of artwork, so there is nothing to preview.
      imagePreviews: false,
      // Translation and proofreading run a command line tool. Turning this on
      // means installing that tool here and deciding whose account it runs as.
      languagePasses: false,
      // The operator decides which folders on this machine are projects, by
      // starting the server with --project. Letting anyone who signs in name
      // a path would let them read anything the server can reach.
      manageProjects: false
    }
  }

  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  registerHandlers((channel, handler) => {
    handlers.set(channel, handler as (...args: unknown[]) => unknown)
  }, services)

  const server = createServer((req, res) => {
    void route(req, res, {
      handlers,
      webRoot: options.webRoot,
      users,
      sessions,
      limiter,
      secure
    })
  })

  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port ?? 0, host, () => {
      const address = server.address()
      resolve(typeof address === 'object' && address ? address.port : 0)
    })
  })

  return {
    port,
    secureCookies: secure,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.()
        server.close(() => resolve())
      })
  }
}

interface Context {
  handlers: Map<string, (...args: unknown[]) => unknown>
  webRoot?: string
  users: ReturnType<typeof createUserStore>
  sessions: ReturnType<typeof createSessionStore>
  limiter: ReturnType<typeof createAttemptLimiter>
  secure: boolean
}

async function route(req: IncomingMessage, res: ServerResponse, ctx: Context): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost')

  // Anything that acts on a request must have come from this app's own pages.
  if (req.method === 'POST' && !originAllowed(req)) {
    send(res, 403, MIME['.json'], JSON.stringify({ error: 'That request came from elsewhere.' }))
    return
  }

  if (url.pathname.startsWith('/auth/')) {
    await handleAuth(req, res, ctx, url.pathname.slice(6))
    return
  }

  if (url.pathname.startsWith('/api/')) {
    const user = await currentUser(req, ctx)
    if (!user) {
      // 401 rather than a redirect: the caller is the app, and it decides what
      // to show a person who is not signed in.
      send(res, 401, MIME['.json'], JSON.stringify({ error: 'Not signed in.' }))
      return
    }
    const channel = decodeURIComponent(url.pathname.slice(5))
    if (!mayPerform(user, channel)) {
      send(res, 403, MIME['.json'], JSON.stringify({ error: refusalFor(user, channel) }))
      return
    }
    await runAsUser(user, () => callHandler(req, res, ctx.handlers, channel))
    return
  }

  if (ctx.webRoot) {
    await serveFile(res, ctx.webRoot, url.pathname)
    return
  }
  send(res, 404, 'text/plain', 'Not found')
}

async function currentUser(req: IncomingMessage, ctx: Context): Promise<User | null> {
  const id = readCookie(req, COOKIE_NAME)
  if (!id) return null
  const session = await ctx.sessions.get(id)
  if (!session) return null
  return ctx.users.byId(session.userId)
}

async function handleAuth(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: Context,
  action: string
): Promise<void> {
  if (action === 'me') {
    const user = await currentUser(req, ctx)
    if (!user) {
      send(res, 401, MIME['.json'], JSON.stringify({ error: 'Not signed in.' }))
      return
    }
    send(res, 200, MIME['.json'], JSON.stringify({ value: user }))
    return
  }

  if (action === 'logout') {
    const id = readCookie(req, COOKIE_NAME)
    if (id) await ctx.sessions.destroy(id)
    res.setHeader('set-cookie', clearedCookie(ctx.secure))
    send(res, 200, MIME['.json'], JSON.stringify({ value: null }))
    return
  }

  if (action !== 'login' || req.method !== 'POST') {
    send(res, 404, MIME['.json'], JSON.stringify({ error: 'No such thing.' }))
    return
  }

  let body: { username?: string; password?: string }
  try {
    body = JSON.parse(await readBody(req))
  } catch {
    send(res, 400, MIME['.json'], JSON.stringify({ error: 'Malformed request.' }))
    return
  }

  const username = String(body.username ?? '').trim().toLowerCase()
  const password = String(body.password ?? '')
  const from = req.socket.remoteAddress ?? 'unknown'
  const key = `${username}|${from}`

  const allowed = ctx.limiter.check(key)
  if (!allowed.allowed) {
    send(
      res,
      429,
      MIME['.json'],
      JSON.stringify({
        error: `Too many attempts. Try again in ${allowed.retryInSeconds} seconds.`
      })
    )
    return
  }

  const user = username && password ? await ctx.users.verify(username, password) : null
  if (!user) {
    ctx.limiter.fail(key)
    // One message for both a wrong name and a wrong password, so this cannot
    // be used to find out which accounts exist.
    send(res, 401, MIME['.json'], JSON.stringify({ error: 'That username and password do not match.' }))
    return
  }

  // A Secure cookie is never sent back over plain HTTP, so signing in would
  // appear to work and then quietly do nothing on the next request. Say so
  // instead of handing out a cookie that cannot come home.
  if (ctx.secure && !arrivedOverHttps(req)) {
    send(
      res,
      400,
      MIME['.json'],
      JSON.stringify({
        error:
          'This server is set to send its session cookie only over HTTPS, but this request ' +
          'arrived over plain HTTP, so signing in could not stick. Put it behind HTTPS, or ' +
          'start it with --insecure-cookies if this is a private network you trust.'
      })
    )
    return
  }

  ctx.limiter.succeed(key)
  const session = await ctx.sessions.create(user.id)
  res.setHeader('set-cookie', sessionCookie(session.id, ctx.secure))
  send(res, 200, MIME['.json'], JSON.stringify({ value: user }))
}

/**
 * One route per operation, named by the same channel the desktop uses. The
 * body is the argument list, so a call reads identically on both transports.
 */
async function callHandler(
  req: IncomingMessage,
  res: ServerResponse,
  handlers: Map<string, (...args: unknown[]) => unknown>,
  channel: string
): Promise<void> {
  const handler = handlers.get(channel)
  if (!handler) {
    send(res, 404, MIME['.json'], JSON.stringify({ error: `No operation named ${channel}.` }))
    return
  }
  if (req.method !== 'POST') {
    send(res, 405, MIME['.json'], JSON.stringify({ error: 'Use POST.' }))
    return
  }

  let args: unknown[]
  try {
    args = JSON.parse(await readBody(req)) as unknown[]
    if (!Array.isArray(args)) throw new Error('The body must be an array of arguments.')
  } catch (e) {
    send(res, 400, MIME['.json'], JSON.stringify({ error: (e as Error).message }))
    return
  }

  try {
    const value = await handler(...args)
    send(res, 200, MIME['.json'], JSON.stringify({ value: value ?? null }))
  } catch (e) {
    // The message is the app's own, written to be read by a person, so it is
    // passed through rather than replaced with a status code alone.
    send(res, 500, MIME['.json'], JSON.stringify({ error: (e as Error).message }))
  }
}

async function serveFile(res: ServerResponse, webRoot: string, pathname: string): Promise<void> {
  // Resolve first, then check containment: no amount of ../ can escape.
  const wanted = path.resolve(webRoot, '.' + (pathname === '/' ? '/index.html' : pathname))
  if (wanted !== webRoot && !wanted.startsWith(webRoot + path.sep)) {
    send(res, 403, 'text/plain', 'Forbidden')
    return
  }

  try {
    const body = await fs.readFile(wanted)
    send(res, 200, MIME[path.extname(wanted).toLowerCase()] ?? 'application/octet-stream', body)
  } catch {
    // A single-page app owns its own routing, so unknown paths get the shell.
    try {
      send(res, 200, MIME['.html'], await fs.readFile(path.join(webRoot, 'index.html')))
    } catch {
      send(res, 404, 'text/plain', 'Not found')
    }
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = ''
    req.on('data', (chunk) => {
      body += String(chunk)
      // A script is text; nothing legitimate here is tens of megabytes.
      if (body.length > 32 * 1024 * 1024) reject(new Error('That request is too large.'))
    })
    req.on('end', () => resolve(body || '[]'))
    req.on('error', reject)
  })
}

function send(
  res: ServerResponse,
  status: number,
  type: string,
  body: string | Buffer
): void {
  res.writeHead(status, {
    'content-type': type,
    'content-length': Buffer.byteLength(body),
    // The page is served by this same origin; nothing else may call it.
    'access-control-allow-origin': 'null',
    'x-content-type-options': 'nosniff'
  })
  res.end(body)
}
