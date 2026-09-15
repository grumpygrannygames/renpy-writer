import { useEffect, useState } from 'react'
import type { VariableUse } from '@shared/api'
import { useStore } from '../state/store'

/**
 * What deleting a character would take with it, before it goes.
 *
 * Two different things can be deleted, and only one of them is safe to take
 * without asking. The profile is notes. A definition is script: every line
 * that speaks as that character needs it, and removing it anyway is a game
 * that loads and then stops the first time they open their mouth. So a
 * definition is offered only when nothing uses it, and when something does
 * this says so, with the count, rather than quietly keeping it.
 */
export default function DeleteCharacterDialog({
  profileId,
  name,
  varNames,
  onClose
}: {
  profileId: string
  name: string
  varNames: string[]
  onClose: () => void
}) {
  const planDeleteCharacter = useStore((s) => s.planDeleteCharacter)
  const deleteCharacter = useStore((s) => s.deleteCharacter)

  const [uses, setUses] = useState<VariableUse[] | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  /** Definitions that will come out, all of the removable ones to begin with. */
  const [chosen, setChosen] = useState<Set<string>>(new Set())

  useEffect(() => {
    let live = true
    planDeleteCharacter(varNames)
      .then((found) => {
        if (!live) return
        setUses(found)
        setChosen(new Set(found.filter(removable).map((u) => u.varName)))
      })
      .catch((e) => live && setFailed(e instanceof Error ? e.message : String(e)))
    return () => {
      live = false
    }
    // Planned once for the character the dialog was opened on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const toggle = (varName: string): void =>
    setChosen((was) => {
      const next = new Set(was)
      if (next.has(varName)) next.delete(varName)
      else next.add(varName)
      return next
    })

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal delete-character-modal" onClick={(e) => e.stopPropagation()}>
        <h2>Delete {name}?</h2>
        <p className="hint">
          The profile and everything noted about {name} will be deleted.
        </p>

        {failed && <p className="error">{failed}</p>}
        {!uses && !failed && <p className="hint">Looking through the script&hellip;</p>}

        {uses && uses.length === 0 && (
          <p className="hint">Not linked to the script, so nothing in the game changes.</p>
        )}

        {uses?.map((use) => (
          <div key={use.varName} className="dc-var">
            <div className="dc-var-name">{use.varName}</div>

            {removable(use) && (
              <>
                <label className="check">
                  <input
                    type="checkbox"
                    checked={chosen.has(use.varName)}
                    onChange={() => toggle(use.varName)}
                  />
                  <span>
                    Also remove its definition &mdash; no script in this project speaks as{' '}
                    {use.varName} or uses it in code
                  </span>
                </label>
                <ul className="dc-lines">
                  {use.defines.map((d) => (
                    <li key={`${d.file}:${d.line}`}>
                      <span className="dc-where">
                        {d.file}:{d.line}
                      </span>{' '}
                      <code>{d.text}</code>
                    </li>
                  ))}
                </ul>
              </>
            )}

            {use.defines.length === 0 && (
              <p className="hint">Not defined in the script, so there is nothing there to remove.</p>
            )}

            {use.defines.length > 0 && use.speaks > 0 && (
              <p className="hint">
                Still speaks <strong>{use.speaks}</strong> {use.speaks === 1 ? 'line' : 'lines'}
                {use.speakFiles > 1 ? ` in ${use.speakFiles} files` : ''}, so the definition stays
                in the script &mdash; without it those lines would stop the game. Remove or
                reassign them, and it can go too.
              </p>
            )}

            {use.defines.length > 0 && use.speaks === 0 && use.mentions.length > 0 && (
              <>
                <p className="hint">Used in code, so the definition stays in the script:</p>
                <ul className="dc-lines">
                  {use.mentions.slice(0, 4).map((m) => (
                    <li key={m}>
                      <code>{m}</code>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
        ))}

        <div className="actions-row">
          <button onClick={onClose}>Keep {name}</button>
          <button
            className="danger"
            disabled={!uses && !failed}
            onClick={() => {
              onClose()
              void deleteCharacter(profileId, [...chosen])
            }}
          >
            Delete {name}
          </button>
        </div>
      </div>
    </div>
  )
}

/** Defined in the script, and used nowhere in it. */
function removable(use: VariableUse): boolean {
  return use.defines.length > 0 && use.speaks === 0 && use.mentions.length === 0
}
