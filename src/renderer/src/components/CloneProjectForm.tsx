import { useState } from 'react'
import { api } from '../api'
import { useStore } from '../state/store'

const REMEMBERED = 'rpw.author'

function remembered(): { name: string; email: string } {
  try {
    return JSON.parse(localStorage.getItem(REMEMBERED) ?? '') ?? { name: '', email: '' }
  } catch {
    return { name: '', email: '' }
  }
}

/**
 * Add a project by copying it from where it lives.
 *
 * A phone has no folder of games to point at. Its projects come from the same
 * remote the desktop sends to, copied without their artwork -- scripts, notes
 * and outline only, as the web server's copy is -- and synced with the same
 * Save and send afterwards.
 */
export default function CloneProjectForm({ onCancel, onDone }: { onCancel: () => void; onDone: () => void }) {
  const openProject = useStore((s) => s.openProject)
  const refreshProjects = useStore((s) => s.refreshProjects)
  const [url, setUrl] = useState('')
  const [token, setToken] = useState('')
  const [name, setName] = useState(remembered().name)
  const [email, setEmail] = useState(remembered().email)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const ready = /^https:\/\/\S+$/i.test(url.trim()) && name.trim() && email.trim() && !busy

  const copy = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      try {
        localStorage.setItem(REMEMBERED, JSON.stringify({ name: name.trim(), email: email.trim() }))
      } catch {
        // Only a convenience for next time.
      }
      const opened = await api.cloneProject({
        url: url.trim(),
        token: token.trim(),
        authorName: name.trim(),
        authorEmail: email.trim()
      })
      await refreshProjects()
      await openProject(opened.project.renpyRoot)
      onDone()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form
      className="clone-form"
      onSubmit={(e) => {
        e.preventDefault()
        if (ready) void copy()
      }}
    >
      <label className="field">
        <span>Repository address</span>
        <input
          autoFocus
          type="url"
          inputMode="url"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          placeholder="https://gitlab.com/you/your-game"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
        />
      </label>
      <label className="field">
        <span>Access token</span>
        <input
          type="password"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          placeholder="Needed for a private repository"
          value={token}
          onChange={(e) => setToken(e.target.value)}
        />
      </label>
      <p className="hint">
        A token that can read and write the repository. It is kept with the copy on this phone and
        nowhere else.
      </p>
      <label className="field">
        <span>Your name</span>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="As your changes should be signed" />
      </label>
      <label className="field">
        <span>Your email</span>
        <input
          type="email"
          inputMode="email"
          autoCapitalize="off"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
      </label>
      <p className="hint">
        Only the scripts, notes and outline are copied, not the artwork, so even a large game takes
        a moment.
      </p>
      {error && <div className="error">{error}</div>}
      <div className="actions-row">
        <button type="button" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button type="submit" className="primary" disabled={!ready}>
          {busy ? 'Copying…' : 'Copy project'}
        </button>
      </div>
    </form>
  )
}
