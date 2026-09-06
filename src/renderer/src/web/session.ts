/**
 * Signing in, for the browser build only.
 *
 * Deliberately outside RenpyWriterApi: the desktop has nobody to sign in as,
 * and putting login in the shared contract would mean every host pretending to
 * have an answer for it. This is part of what it means to be a web page, not
 * part of what the app does.
 */

export interface SignedInUser {
  id: string
  username: string
  role: 'admin' | 'writer' | 'proofreader' | 'viewer'
  createdAt: string
}

async function call(path: string, body?: unknown): Promise<unknown> {
  const response = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    credentials: 'same-origin',
    body: body === undefined ? undefined : JSON.stringify(body)
  })

  let payload: { value?: unknown; error?: string }
  try {
    payload = (await response.json()) as { value?: unknown; error?: string }
  } catch {
    throw new Error(`The server answered ${response.status}.`)
  }
  if (payload.error) throw new Error(payload.error)
  return payload.value
}

/** The signed-in person, or null when nobody is. */
export async function whoAmI(): Promise<SignedInUser | null> {
  try {
    return (await call('/auth/me')) as SignedInUser
  } catch {
    return null
  }
}

export async function signIn(username: string, password: string): Promise<SignedInUser> {
  return (await call('/auth/login', { username, password })) as SignedInUser
}

export async function signOut(): Promise<void> {
  await call('/auth/logout', {})
}

const listeners = new Set<() => void>()

/**
 * A session can end while the app is open -- it expires, or somebody signs out
 * elsewhere. The transport reports that, and whoever is showing the app puts
 * the sign-in screen back rather than leaving a dead interface on screen.
 */
export function onSignedOut(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function reportSignedOut(): void {
  for (const listener of listeners) listener()
}
