import { useState } from 'react'
import { signIn } from './session'

/**
 * The sign-in screen, shown by the browser build when nobody is signed in.
 *
 * It says nothing about whether an account exists: the server answers a wrong
 * username and a wrong password identically, and repeating that here keeps it
 * that way.
 */
export default function LoginScreen({ onSignedIn }: { onSignedIn: () => void }) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(e: React.FormEvent): Promise<void> {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await signIn(username, password)
      onSignedIn()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="gate">
      <form className="gate-card" onSubmit={submit}>
        <h1>Ren&rsquo;Py Writer</h1>
        <p className="hint">Sign in to reach your projects.</p>

        <label className="field">
          <span>Username</span>
          <input
            value={username}
            autoCapitalize="none"
            autoCorrect="off"
            autoComplete="username"
            onChange={(e) => setUsername(e.target.value)}
          />
        </label>

        <label className="field">
          <span>Password</span>
          <input
            type="password"
            value={password}
            autoComplete="current-password"
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>

        {error && <div className="error">{error}</div>}

        <div className="actions-row">
          <button className="primary" type="submit" disabled={busy || !username || !password}>
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
        </div>

        <p className="hint">
          Accounts are made by whoever runs the server. There is no sign-up here on purpose.
        </p>
      </form>
    </div>
  )
}
