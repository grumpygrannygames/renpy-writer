import { useState } from 'react'
import { useStore } from '../state/store'
import { useCast } from '../useCast'
import { readableOn } from '../color'
import CharacterFields from './CharacterFields'

/** Must match --bg in styles.css. */
const EDITOR_BG = '#16161a'

/**
 * A character profile at full size. The profile's own fields sit above the
 * script variables it covers, since one person can need several Ren'Py
 * definitions (alice, alice_thoughts, alice_nvl).
 */
export default function CharacterEditor({ characterKey }: { characterKey: string }) {
  const { profiles, unassigned, linkIndex } = useCast()
  const upsertCharacterNote = useStore((s) => s.upsertCharacterNote)
  const renameScriptCharacter = useStore((s) => s.renameScriptCharacter)
  const openCharacterTab = useStore((s) => s.openCharacterTab)

  const [adding, setAdding] = useState('')
  const [renameError, setRenameError] = useState<string | null>(null)

  const profile = profiles.find((p) => p.note.id === characterKey)

  if (!profile) {
    return (
      <div className="placeholder">
        <h2>Character not found</h2>
        <p>This profile has been deleted.</p>
      </div>
    )
  }

  const { note } = profile

  function assign(varName: string): void {
    if (!varName) return
    upsertCharacterNote({ ...note, varNames: [...note.varNames, varName] })
    setAdding('')
  }

  function unassign(varName: string): void {
    upsertCharacterNote({ ...note, varNames: note.varNames.filter((v) => v !== varName) })
  }

  return (
    <div className="chareditor">
      <div className="ce-inner">
        <div className="ce-head">
          <h1 style={{ color: readableOn(profile.color, EDITOR_BG, 'var(--text)') }}>{note.name}</h1>
          {profile.variables.length > 0 && (
            <span className="ce-var">
              {profile.variables.length} script variable
              {profile.variables.length === 1 ? '' : 's'}
            </span>
          )}
        </div>

        <CharacterFields
          note={note}
          linkIndex={linkIndex}
          layout="full"
          onChange={upsertCharacterNote}
          onFollow={(target) => {
            if (target.kind === 'character') {
              const to = profiles.find((p) => p.note.id === target.id)
              openCharacterTab(target.id, to?.note.name ?? target.name)
            }
          }}
        />

        <section className="ce-vars">
          <h2>Script variables</h2>
          <p className="rf-hint">
            Each variable keeps its own display name in the script, so a disguise or an inner voice
            can read differently while staying one profile.
          </p>

          {profile.variables.length === 0 && profile.missing.length === 0 && (
            <p className="ce-empty">
              Not linked to the script yet. This profile exists only in your notes.
            </p>
          )}

          <ul className="ce-varlist">
            {profile.variables.map((v) => (
              <li key={v.varName}>
                <span className="cv-name" style={{ color: readableOn(v.color, EDITOR_BG, 'var(--text)') }}>
                  {v.varName}
                </span>
                <ScriptName
                  value={v.name}
                  onCommit={async (next) => {
                    setRenameError(null)
                    const err = await renameScriptCharacter(v.varName, next)
                    if (err) setRenameError(err)
                  }}
                />
                {v.expressions.length > 0 && (
                  <span className="cv-count">{v.expressions.length} expressions</span>
                )}
                <button className="ghost cv-remove" onClick={() => unassign(v.varName)}>
                  Unlink
                </button>
              </li>
            ))}

            {profile.missing.map((v) => (
              <li key={v} className="cv-missing">
                <span className="cv-name">{v}</span>
                <span className="cv-warn">not in the script any more</span>
                <button className="ghost cv-remove" onClick={() => unassign(v)}>
                  Unlink
                </button>
              </li>
            ))}
          </ul>

          {renameError && <div className="error">{renameError}</div>}

          <div className="ce-assign">
            <select value={adding} onChange={(e) => assign(e.target.value)}>
              <option value="">Link another variable&hellip;</option>
              {unassigned.map((c) => (
                <option key={c.varName} value={c.varName}>
                  {c.varName} — {c.name}
                </option>
              ))}
            </select>
            {unassigned.length === 0 && (
              <span className="rf-hint">Every script character already belongs to a profile.</span>
            )}
          </div>
        </section>

        {profile.expressions.length > 0 && (
          <section className="ce-vars">
            <h2>Expressions ({profile.expressions.length})</h2>
            <div className="rd-chips">
              {profile.expressions.map((x) => (
                <span key={x} className="rd-chip">
                  {x}
                </span>
              ))}
            </div>
          </section>
        )}
      </div>
    </div>
  )
}

/** The display name as the script has it, editable in place. */
function ScriptName({
  value,
  onCommit
}: {
  value: string
  onCommit: (next: string) => Promise<void>
}) {
  const [editing, setEditing] = useState(false)

  if (!editing) {
    return (
      <button
        className="cv-script"
        title="Display name in the script — click to rename"
        onClick={() => setEditing(true)}
      >
        {value}
      </button>
    )
  }
  return (
    <input
      className="cv-script-input"
      autoFocus
      defaultValue={value}
      onBlur={(e) => {
        const next = e.target.value.trim()
        setEditing(false)
        if (next && next !== value) void onCommit(next)
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === 'Escape') e.currentTarget.blur()
      }}
    />
  )
}
