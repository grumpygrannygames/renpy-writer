import { useState } from 'react'
import { useStore } from '../state/store'

/** "episode_1.rpy" -> "Episode 1" */
function nameFromFile(fileName: string): string {
  return fileName
    .replace(/\.rpy$/, '')
    .split('_')
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ')
}

export default function NewEpisodeDialog({ onClose }: { onClose: () => void }) {
  const opened = useStore((s) => s.opened)
  const createEpisode = useStore((s) => s.createEpisode)

  const [mode, setMode] = useState<'new' | 'import'>('new')
  const [name, setName] = useState('')
  const [fileName, setFileName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const available = opened?.unregisteredFiles ?? []
  const slug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
  const canSubmit =
    !busy && (mode === 'new' ? name.trim().length > 0 && slug.length > 0 : fileName.length > 0)

  async function submit() {
    setBusy(true)
    setError(null)
    try {
      await createEpisode({
        mode,
        name: mode === 'new' ? name.trim() : nameFromFile(fileName),
        fileName: mode === 'import' ? fileName : undefined
      })
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Add episode</h2>

        <div className="seg-choice">
          <button className={mode === 'new' ? 'on' : ''} onClick={() => setMode('new')}>
            <span className="t">New</span>
            <span className="d">Create an empty .rpy file</span>
          </button>
          <button
            className={mode === 'import' ? 'on' : ''}
            onClick={() => setMode('import')}
            disabled={available.length === 0}
          >
            <span className="t">Import existing</span>
            <span className="d">
              {available.length === 0
                ? 'Nothing left to adopt'
                : `${available.length} file${available.length === 1 ? '' : 's'} available`}
            </span>
          </button>
        </div>

        {mode === 'new' ? (
          <label className="field">
            <span>Episode name</span>
            <input
              autoFocus
              value={name}
              placeholder="Episode 1"
              onChange={(e) => setName(e.target.value)}
            />
            <div className="hint">
              {slug ? `Creates ${slug}.rpy with a starting label.` : 'Creates a new .rpy file.'}
            </div>
          </label>
        ) : (
          <label className="field">
            <span>Script file</span>
            <select value={fileName} onChange={(e) => setFileName(e.target.value)}>
              <option value="">Choose a file&hellip;</option>
              {available.map((f) => (
                <option key={f} value={f}>
                  {f}
                </option>
              ))}
            </select>
            <div className="hint">
              {fileName
                ? `Adopted as "${nameFromFile(fileName)}". The file is read, never rewritten.`
                : 'Existing labels become beats in the outline.'}
            </div>
          </label>
        )}

        {error && <div className="error">{error}</div>}

        <div className="actions-row">
          <button onClick={onClose}>Cancel</button>
          <button className="primary" disabled={!canSubmit} onClick={() => void submit()}>
            {mode === 'new' ? 'Create' : 'Import'}
          </button>
        </div>
      </div>
    </div>
  )
}
