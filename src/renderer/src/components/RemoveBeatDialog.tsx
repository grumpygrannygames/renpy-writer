import type { RemoveBeatPlan } from '@shared/api'
import { useStore } from '../state/store'
import { beatName } from '../beatName'

export interface PendingRemoval {
  id: string
  title: string
  plan: RemoveBeatPlan
}

/**
 * What removing a scene would cost, before it is removed.
 *
 * Cutting a beat writes to the script, so this says how much of the file goes
 * and refuses outright when another scene jumps here -- a dangling jump is a
 * game that stops mid-story, and it would be found by playing rather than by
 * looking. Shared by the plot board and the writer, which are two doors into
 * the same act.
 */
export default function RemoveBeatDialog({
  removing,
  onClose
}: {
  removing: PendingRemoval
  onClose: () => void
}) {
  const removeBeat = useStore((s) => s.removeBeat)
  const blocked = removing.plan.referencedBy.length > 0

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal remove-modal" onClick={(e) => e.stopPropagation()}>
        <h2>Remove {beatName(removing.title)}?</h2>

        {blocked ? (
          <>
            <p className="error">
              {removing.plan.referencedBy.length === 1
                ? 'Another scene jumps here'
                : `${removing.plan.referencedBy.length} other scenes jump here`}
              , so removing it would leave them going nowhere.
            </p>
            <ul className="rm-list">
              {removing.plan.referencedBy.map((who) => (
                <li key={who}>{who}</li>
              ))}
            </ul>
            <p className="hint">Point those somewhere else first, and this can go.</p>
          </>
        ) : (
          <>
            <p className="hint">
              <strong>{removing.plan.lines}</strong>{' '}
              {removing.plan.lines === 1 ? 'line' : 'lines'} will be removed from{' '}
              <code>{removing.plan.fileName}</code>. This writes to the script.
            </p>
            {removing.plan.retargeted.length > 0 && (
              <p className="hint">
                {removing.plan.retargeted.length === 1
                  ? `${beatName(removing.plan.retargeted[0])} ends by jumping here, so it will`
                  : `${removing.plan.retargeted.length} scenes end by jumping here, so they will`}{' '}
                jump to whatever follows instead.
              </p>
            )}
            {removing.plan.runsIntoInstead && (
              <p className="hint">
                {beatName(removing.plan.runsIntoInstead.from)} runs straight into this scene, so
                afterwards it will run into{' '}
                {removing.plan.runsIntoInstead.to
                  ? beatName(removing.plan.runsIntoInstead.to)
                  : 'whatever follows the file'}{' '}
                instead.
              </p>
            )}
          </>
        )}

        <div className="actions-row">
          <button onClick={onClose}>{blocked ? 'Close' : 'Keep it'}</button>
          {!blocked && (
            <button
              className="danger"
              onClick={() => {
                const id = removing.id
                onClose()
                void removeBeat(id)
              }}
            >
              Remove it
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
