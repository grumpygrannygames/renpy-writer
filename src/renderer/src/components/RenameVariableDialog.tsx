import { useState } from 'react'
import { useStore } from '../state/store'

/**
 * Renaming a character in the script.
 *
 * Two fields rather than two dialogs, because they are one thought: Cook
 * becoming Detective Cook is a new variable and a new name to speak under, and
 * a writer who changes one usually means both.
 *
 * The variable is the risky half. It appears on every line that character
 * speaks, so renaming it rewrites the whole project -- and if it also appears
 * somewhere that cannot be rewritten safely, nothing is written at all and the
 * places are listed here instead.
 */
export default function RenameVariableDialog({
  varName,
  name,
  onClose
}: {
  varName: string
  name: string
  onClose: () => void
}) {
  const renameScriptVariable = useStore((s) => s.renameScriptVariable)
  const [nextVar, setNextVar] = useState(varName)
  const [nextName, setNextName] = useState(name)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [mentions, setMentions] = useState<string[]>([])

  const changed = nextVar.trim() !== varName || nextName.trim() !== name
  const ready = changed && nextVar.trim().length > 0 && nextName.trim().length > 0 && !busy

  async function save(): Promise<void> {
    setBusy(true)
    setError(null)
    setMentions([])
    try {
      const result = await renameScriptVariable(varName, {
        varName: nextVar.trim(),
        name: nextName.trim()
      })
      if (result.error) {
        setError(result.error)
        setMentions(result.mentions ?? [])
        return
      }
      onClose()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="modal-backdrop" onClick={() => !busy && onClose()}>
      <div className="modal rename-modal" onClick={(e) => e.stopPropagation()}>
        <h2>Rename {varName}</h2>

        <label className="field">
          <span>Script variable</span>
          <input
            autoFocus
            value={nextVar}
            onChange={(e) => setNextVar(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && ready) void save()
            }}
          />
        </label>
        <p className="hint">
          What the script calls them: <code>{nextVar.trim() || varName} &quot;…&quot;</code> on every
          line they speak. Image tags are left alone, so their pictures keep working.
        </p>

        <label className="field">
          <span>Name in the script</span>
          <input
            value={nextName}
            onChange={(e) => setNextName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && ready) void save()
            }}
          />
        </label>
        <p className="hint">What the player sees above their dialogue.</p>

        {error && <div className="error">{error}</div>}
        {mentions.length > 0 && (
          <>
            <ul className="rm-list">
              {mentions.map((where) => (
                <li key={where}>{where}</li>
              ))}
            </ul>
            <p className="hint">
              Nothing was written. Change those by hand first, or leave the variable as it is.
            </p>
          </>
        )}

        <div className="actions-row">
          <button onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="primary" disabled={!ready} onClick={() => void save()}>
            {busy ? 'Rewriting…' : 'Rename'}
          </button>
        </div>
      </div>
    </div>
  )
}
