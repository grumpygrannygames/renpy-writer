import * as path from 'node:path'
import { app, BrowserWindow, shell } from 'electron'
import { registerIpc } from './ipc'

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    show: false,
    title: "Ren'Py Writer",
    backgroundColor: '#1b1b1f',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.mjs'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  win.on('ready-to-show', () => win.show())

  // Renderer problems otherwise only appear in devtools, which makes a blank
  // window hard to diagnose. Forward them to the terminal.
  // Reading only the event object keeps us off the deprecated positional args.
  win.webContents.on('console-message', (event) => {
    if (event.level === 'warning' || event.level === 'error') {
      console.error(`[renderer] ${event.message} (${event.sourceId}:${event.lineNumber})`)
    }
  })
  win.webContents.on('did-fail-load', (_e, code, description, url) => {
    console.error(`[renderer] failed to load ${url}: ${description} (${code})`)
  })
  win.webContents.on('render-process-gone', (_e, details) => {
    console.error(`[renderer] process gone: ${details.reason}`)
  })

  win.webContents.setWindowOpenHandler(({ url }) => {
    // Handing a URL to openExternal hands it to whatever the system has
    // registered for that scheme, and some of what the app shows as a link
    // came from a remote server. Only http and https get out.
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void win.loadFile(path.join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  // Named in the log because "my projects are gone" is almost always a
  // question of which profile folder the app is reading.
  console.log(`[renpy-writer] ${app.getName()} settings: ${app.getPath('userData')}`)
  registerIpc()
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
