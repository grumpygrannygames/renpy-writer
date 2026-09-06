import { BrowserWindow, app, dialog, ipcMain } from 'electron'
import { registerHandlers, type HostServices } from '@core/handlers'
import { useSettingsDir } from '@core/machine'
import {
  readMachineProject,
  updateMachineProject
} from '@core/machine'
import { encodeWithChromium } from './encoder'
import {
  readRegistryDetailed,
  removeProjectRef,
  upsertProjectRef
} from './projects/registry'

/**
 * The Electron door onto the handlers.
 *
 * Everything the app can do lives in core; this file only says how a desktop
 * answers the three questions core cannot: how to ask for a folder, where the
 * per-machine lists are kept, and whether there is an image encoder to hand.
 * A server answers the same three differently and reuses everything else.
 */
export function registerIpc(): void {
  useSettingsDir(app.getPath('userData'))

  const host: HostServices = {
    async pickFolder() {
      const win = BrowserWindow.getFocusedWindow()
      const result = win
        ? await dialog.showOpenDialog(win, { properties: ['openDirectory'] })
        : await dialog.showOpenDialog({ properties: ['openDirectory'] })
      return result.canceled ? null : result.filePaths[0]
    },
    registry: {
      read: readRegistryDetailed,
      upsert: upsertProjectRef,
      remove: removeProjectRef
    },
    machine: {
      read: readMachineProject,
      update: updateMachineProject
    },
    // Chromium's WebP encoder, which only exists because this is Electron.
    builtinEncoder: encodeWithChromium,
    // A desktop has the lot: somebody at the keyboard, the render folder, the
    // images, and a command line to run the language passes on.
    capabilities: {
      folderPicker: true,
      renderSync: true,
      imagePreviews: true,
      languagePasses: true,
      manageProjects: true
    }
  }

  registerHandlers((channel, handler) => {
    // The event object is Electron's and means nothing to a handler, so it is
    // dropped here rather than travelling through every signature in core.
    ipcMain.handle(channel, (_event, ...args) =>
      (handler as (...a: unknown[]) => unknown)(...args)
    )
  }, host)
}
