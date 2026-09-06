import { useMemo, useState } from 'react'
import type { CharacterNote } from '@shared/types'
import { useCast, newId } from '../useCast'

/**
 * Creating a profile is where script variables get claimed. Selecting none
 * makes a notes-only character; selecting several says those definitions are
 * one person.
 */
export default function AddCharacterDialog({
  preselect,
  onClose,
  onCreate
}: {
  /** Variable to tick on open, e.g. from the unassigned list. */
  preselect?: string
  onClose: () => void
  onCreate: (note: CharacterNote) => void
}) {
  const { unassigned } = useCast()
  const [picked, setPicked] = useState<string[]>(preselect ? [preselect] : [])
  const [name, setName] = useState(
    preselect ? (unassigned.find((c) => c.varName === preselect)?.name ?? '') : ''
  )
  const [touchedName, setTouchedName] = useState(!!preselect)
  const [filter, setFilter] = useState('')

  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase()
    if (!q) return unassigned
    return unassigned.filter(
      (c) => c.varName.toLowerCase().includes(q) || c.name.toLowerCase().includes(q)
    )
  }, [unassigned, filter])

  function toggle(varName: string): void {
    setPicked((p) => {
      const next = p.includes(varName) ? p.filter((v) => v !== varName) : [...p, varName]
      // Suggest the first pick's script name until the writer types their own.
      if (!touchedName) {
        const first = next[0]
        setName(first ? (unassigned.find((c) => c.varName === first)?.name ?? '') : '')
      }
      return next
    })
  }

  const finalName = name.trim() || 'New character'

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Add character</h2>

        <label className="field">
          <span>Name in your notes</span>
          <input
            autoFocus
            value={name}
            placeholder="New character"
            onChange={(e) => {
              setName(e.target.value)
              setTouchedName(true)
            }}
          />
        </label>

        <div className="field">
          <span className="rf-label">
            Script variables ({picked.length} selected)
          </span>
          <div className="hint" style={{ marginBottom: 8 }}>
            Pick every definition that is this person. Leave it empty for someone not written yet.
          </div>

          {unassigned.length === 0 ? (
            <p className="ce-empty">Every script character already belongs to a profile.</p>
          ) : (
            <>
              <input
                value={filter}
                placeholder="Filter variables"
                onChange={(e) => setFilter(e.target.value)}
                style={{ marginBottom: 8 }}
              />
              <ul className="pick-list">
                {shown.map((c) => (
                  <li
                    key={c.varName}
                    className={picked.includes(c.varName) ? 'on' : ''}
                    onClick={() => toggle(c.varName)}
                  >
                    <input type="checkbox" readOnly checked={picked.includes(c.varName)} />
                    <span className="pl-var">{c.varName}</span>
                    <span className="pl-name">{c.name}</span>
                    {c.expressions.length > 0 && (
                      <span className="pl-count">{c.expressions.length}</span>
                    )}
                  </li>
                ))}
                {shown.length === 0 && <li className="ce-empty">Nothing matches that filter.</li>}
              </ul>
            </>
          )}
        </div>

        <div className="actions-row">
          <button onClick={onClose}>Cancel</button>
          <button
            className="primary"
            onClick={() =>
              onCreate({ id: newId(), varNames: picked, name: finalName })
            }
          >
            Create {picked.length > 0 ? `with ${picked.length} variable${picked.length === 1 ? '' : 's'}` : 'notes-only'}
          </button>
        </div>
      </div>
    </div>
  )
}
