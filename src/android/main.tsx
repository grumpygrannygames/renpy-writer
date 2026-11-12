import './shims/process'
import React from 'react'
import ReactDOM from 'react-dom/client'
import '../renderer/src/styles.css'

/**
 * The Android app: the same interface, with everything it asks answered on
 * the phone. There is nobody to sign in as -- the phone is one person's, like
 * a desktop -- so the app is shown directly once the phone has said where its
 * files go.
 */
const root = ReactDOM.createRoot(document.getElementById('root')!)

async function boot(): Promise<void> {
  const { start } = await import('./native')
  await start()
  // Only now: the shared code reads the app's folders as it sets up.
  const [{ setApi }, { createLocalApi }, { default: App }] = await Promise.all([
    import('../renderer/src/api'),
    import('./localApi'),
    import('../renderer/src/App')
  ])
  setApi(createLocalApi())
  root.render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  )
}

boot().catch((e) => {
  root.render(
    <div className="gate">
      <div className="gate-card">
        <h1>Ren&rsquo;Py Writer</h1>
        <p className="error">
          The app could not start: {e instanceof Error ? e.message : String(e)}
        </p>
      </div>
    </div>
  )
})
