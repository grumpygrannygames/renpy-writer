import { useState } from 'react'
import { useStore } from '../state/store'
import { beatName } from '../beatName'

/**
 * A beat's note, from the outline.
 *
 * The plot board is where notes were written, and a phone cannot reach the
 * plot board -- so the outline, which a phone does show, opens the same note
 * here. Notes are kept with the outline and never written into the script.
 */
export default function BeatNoteDialog({
  beatId,
  title,
  note,
  onClose
}: {
  beatId: string
  title: string
  note: string
  onClose: () => void
}) {
  const updateBeat = useStore((s) => s.updateBeat)
  const [text, setText] = useState(note)
  const changed = text.trim() !== note.trim()

  const save = (): void => {
    onClose()
    if (changed) void updateBeat(beatId, { description: text.trim() })
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal beat-modal beat-note-modal" onClick={(e) => e.stopPropagation()}>
        <h2>{beatName(title)}</h2>
        <label className="field">
          <span>Note</span>
          <textarea
            autoFocus
            rows={7}
            value={text}
            placeholder="What this scene is for, before it exists."
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') onClose()
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) save()
            }}
          />
        </label>
        <p className="hint">Kept with the outline, never written into the script.</p>
        <div className="actions-row">
          <span className="spacer" />
          <button onClick={onClose}>Cancel</button>
          <button className="primary" disabled={!changed} onClick={save}>
            Save
          </button>
        </div>
      </div>
    </div>
  )
}
