import React, { useCallback, useEffect, useState } from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { currentApi, setApi } from './api'
import { createHttpApi } from './httpApi'
import LoginScreen from './web/LoginScreen'
import { onSignedOut, whoAmI, type SignedInUser } from './web/session'
import './styles.css'

/**
 * The hook a host uses to say what answers the app's calls.
 *
 * Electron needs nothing here: its preload bridge already put an
 * implementation on the page. A browser build calls setApi() with one that
 * speaks to a server before the app asks for anything.
 */
declare global {
  interface Window {
    renpyWriter?: {
      setApi: typeof setApi
      currentApi: typeof currentApi
      connectTo: (baseUrl?: string) => void
    }
  }
}

const connectTo = (baseUrl = ''): void => setApi(createHttpApi(baseUrl))
window.renpyWriter = { setApi, currentApi, connectTo }

/**
 * Which build is this, and is it in one piece?
 *
 * A missing bridge used to mean one thing: the browser. It can also mean the
 * preload script failed to load, and then treating it as the browser sends
 * the desktop app to a sign-in screen for a server that is not there -- an
 * unanswerable question, and one that reads as "your projects are gone".
 *
 * The two are told apart by where the page came from, not by the user agent.
 * The desktop build opens a file from disk; anything served over HTTP came
 * from a server and can go on talking to it. A user-agent test looked right
 * and was not: a browser window opened by Electron still says Electron in its
 * user agent while being, in every way that matters here, the browser.
 */
const fromDisk = location.protocol === 'file:'
const bridgeMissing = !currentApi() && fromDisk
const isWeb = !currentApi() && !fromDisk
if (isWeb) connectTo('')

/** Said plainly, because no amount of clicking in the app will fix it. */
function BridgeMissing() {
  return (
    <div className="gate">
      <div className="gate-card">
        <h1>Ren&rsquo;Py Writer</h1>
        <p className="error">
          The part of the app that reaches your files did not load, so nothing here can open a
          project. Your work is untouched: this is the app failing to start properly, not
          anything missing on disk.
        </p>
        <p className="hint">
          Close the app and open it again. If it keeps happening, the build is incomplete --
          run <code>npm run build</code> and reopen.
        </p>
      </div>
    </div>
  )
}

/**
 * On the web the app is behind a sign-in; on the desktop there is nobody to
 * sign in as, so it is shown directly.
 */
function Root() {
  const [user, setUser] = useState<SignedInUser | null>(null)
  const [checked, setChecked] = useState(false)

  const check = useCallback(async () => {
    setUser(await whoAmI())
    setChecked(true)
  }, [])

  useEffect(() => {
    void check()
    // A session can end while the app is open. Put the sign-in screen back
    // rather than leaving an interface that quietly fails every call.
    return onSignedOut(() => setUser(null))
  }, [check])

  if (!checked) return <div className="gate" />
  if (!user) return <LoginScreen onSignedIn={() => void check()} />
  return <App />
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {bridgeMissing ? <BridgeMissing /> : isWeb ? <Root /> : <App />}
  </React.StrictMode>
)
