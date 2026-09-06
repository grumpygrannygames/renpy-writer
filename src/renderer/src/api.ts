import type { RenpyWriterApi } from '@shared/api'

/**
 * The one place the interface reaches the outside world.
 *
 * Every call the app makes goes through here rather than through `window.api`
 * directly, so what answers those calls is a choice rather than an assumption.
 * On the desktop it is Electron's preload bridge. On anything else -- a browser
 * tab, a phone -- a host can install an implementation that speaks HTTP to a
 * server, and no component above this file changes or knows.
 */

let installed: RenpyWriterApi | null = null
const listeners = new Set<() => void>()

/**
 * Install a transport. A non-Electron host calls this before rendering;
 * passing null goes back to whatever the page provides.
 *
 * Anything already on screen is told, because a transport can arrive after the
 * app has drawn: a browser build that signs in and only then knows where to
 * send its calls would otherwise be left showing whatever the first, failed
 * attempt produced.
 */
export function setApi(next: RenpyWriterApi | null): void {
  installed = next
  for (const listener of listeners) listener()
}

/** Called when the transport changes. Returns a function to stop listening. */
export function onApiChange(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** What is currently answering, for a host that wants to wrap it. */
export function currentApi(): RenpyWriterApi | null {
  return installed ?? bridge()
}

function bridge(): RenpyWriterApi | null {
  return (globalThis as { api?: RenpyWriterApi }).api ?? null
}

function resolve(): RenpyWriterApi {
  const impl = installed ?? bridge()
  if (!impl) {
    throw new Error(
      'This build has no connection to a workspace. A host must call setApi() ' +
        'with an implementation before the app can read or write anything.'
    )
  }
  return impl
}

/**
 * Resolved per call rather than captured once, so installing a transport after
 * the modules have loaded still takes effect, and so a failure to install one
 * is reported when something is actually attempted.
 */
export const api: RenpyWriterApi = new Proxy({} as RenpyWriterApi, {
  get(_target, property: string | symbol) {
    const impl = resolve() as unknown as Record<string | symbol, unknown>
    const value = impl[property]
    return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(impl) : value
  }
})
