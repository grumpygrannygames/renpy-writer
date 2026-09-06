import type { RenpyWriterApi } from '@shared/api'
import { IPC } from '@shared/api'
import { reportSignedOut } from './web/session'

/**
 * The transport a browser uses: the same operations, over HTTP.
 *
 * Every method is generated rather than written out, because the contract is
 * already the single source of truth. A method added to RenpyWriterApi works
 * here the moment the server registers it, and there is no list to forget to
 * update.
 */
export function createHttpApi(baseUrl = ''): RenpyWriterApi {
  const base = baseUrl.replace(/\/+$/, '')

  return new Proxy({} as RenpyWriterApi, {
    get(_target, property: string | symbol) {
      if (typeof property !== 'string') return undefined

      // Routes are named by the same channel constant the desktop registers
      // on, so neither transport invents its own vocabulary for an operation.
      const channel = (IPC as Record<string, string>)[property]
      if (!channel) {
        return async () => {
          throw new Error(`There is no operation called ${property}.`)
        }
      }

      return async (...args: unknown[]) => {
        const response = await fetch(`${base}/api/${encodeURIComponent(channel)}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          // Sessions live in a cookie, so the browser must be told to send it.
          credentials: 'same-origin',
          body: JSON.stringify(args)
        })

        let payload: { value?: unknown; error?: string }
        try {
          payload = (await response.json()) as { value?: unknown; error?: string }
        } catch {
          throw new Error(
            `The server answered ${response.status} with something that was not JSON.`
          )
        }

        // A session that has ended is not an error to show inside the app; it
        // means the sign-in screen belongs back on top of it.
        if (response.status === 401) {
          reportSignedOut()
          throw new Error(payload.error ?? 'Not signed in.')
        }

        // The server passes the app's own message through, so a failure reads
        // the same here as it does on the desktop rather than as a status code.
        if (payload.error) throw new Error(payload.error)
        if (!response.ok) throw new Error(`The server answered ${response.status}.`)
        return payload.value
      }
    }
  })
}
