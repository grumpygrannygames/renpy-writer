import { AsyncLocalStorage } from 'node:async_hooks'
import type { User } from './users'

/**
 * Who the request being handled belongs to.
 *
 * Handlers are registered once at startup, but the person calling them changes
 * with every request. A mutable "current user" would be wrong the moment two
 * requests overlap, which on a server is immediately; async local storage
 * keeps each request's answer to itself for as long as that request runs.
 */
const store = new AsyncLocalStorage<User>()

export function runAsUser<T>(user: User, fn: () => T): T {
  return store.run(user, fn)
}

export function currentUser(): User | null {
  return store.getStore() ?? null
}

/**
 * An address for the commit trailer.
 *
 * Accounts carry an email when one was given; otherwise a stable local one is
 * derived, so history has something to attribute to rather than nothing.
 */
export function authorFor(user: User): { name: string; email: string } {
  return {
    name: user.username,
    email: user.email ?? `${user.username}@renpywriter.local`
  }
}
