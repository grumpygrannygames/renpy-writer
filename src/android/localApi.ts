import * as nodePath from 'node:path'
import type { RenpyWriterApi } from '@shared/api'
import { IPC } from '@shared/api'
import { registerHandlers, type HostServices } from '@core/handlers'
import { readMachineProject, updateMachineProject, useSettingsDir } from '@core/machine'
import { createFileRegistry } from '../server/registry'
import { where } from './native'

/**
 * The app's operations, answered on the phone itself.
 *
 * The same handlers the desktop and the server register, called directly
 * instead of over Electron's bridge or HTTP. What a phone answers differently
 * is only what a host is asked: there is nobody to pick a folder from, no
 * renders, no artwork and no command line tools -- the same as the web -- but
 * projects are its own to add, by copying them from where they live.
 */
export function createLocalApi(): RenpyWriterApi {
  const settings = nodePath.join(where.files, 'settings')
  useSettingsDir(settings)

  const host: HostServices = {
    async pickFolder() {
      return null
    },
    registry: createFileRegistry(settings),
    machine: {
      read: readMachineProject,
      update: updateMachineProject
    },
    capabilities: {
      folderPicker: false,
      renderSync: false,
      imagePreviews: false,
      languagePasses: false,
      manageProjects: true,
      cloneProjects: true
    },
    projectsDir: nodePath.join(where.files, 'projects')
  }

  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  registerHandlers((channel, handler) => {
    handlers.set(channel, handler as (...args: unknown[]) => unknown)
  }, host)

  return new Proxy({} as RenpyWriterApi, {
    get(_target, property: string | symbol) {
      if (typeof property !== 'string') return undefined
      const channel = (IPC as Record<string, string>)[property]
      const handler = channel ? handlers.get(channel) : undefined
      if (!handler) {
        return async () => {
          throw new Error(`There is no operation called ${property}.`)
        }
      }
      // Copied in and out, as the other transports do by sending JSON: the
      // store must never share an object with the code that wrote it.
      return async (...args: unknown[]) => {
        const value = await handler(...structuredClone(args))
        return value === undefined ? undefined : structuredClone(value)
      }
    }
  })
}
