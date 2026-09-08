import { useState } from 'react'
import type { LabelEndKind } from '@shared/types'
import { useStore } from '../state/store'
import type { RemoveBeatPlan } from '@shared/api'
import RemoveBeatDialog from './RemoveBeatDialog'
import { beatName } from '../beatName'

const END_LABEL: Record<LabelEndKind, string> = {
  jump: '',
  fallthrough: 'falls through',
  'hand-authored': 'branches'
}

const END_COLOR: Record<LabelEndKind, string> = {
  jump: 'var(--text-faint)',
  fallthrough: 'var(--warn)',
  'hand-authored': 'var(--accent)'
}

interface DragState {
  label: string
  fromEpisodeId: string
}

/**
 * Every episode side by side, so a beat can be dragged from one to another.
 *
 * Moving a beat rewrites the script: the label block is cut from one file and
 * placed in another. Fall-through is written out as an explicit jump first, so
 * the story keeps running the same way whatever the new file order is.
 */

export default function PlotBoard() {
  const opened = useStore((s) => s.opened)
  const parsed = useStore((s) => s.parsed)
  const moveBeat = useStore((s) => s.moveBeat)
  const reorderEpisodes = useStore((s) => s.reorderEpisodes)
  const setEpisodeStatus = useStore((s) => s.setEpisodeStatus)
  const openEpisode = useStore((s) => s.openEpisode)
  const reportError = useStore((s) => s.reportError)
  const lastMove = useStore((s) => s.lastMove)
  const clearLastMove = useStore((s) => s.clearLastMove)
  const createBeat = useStore((s) => s.createBeat)
  const updateBeat = useStore((s) => s.updateBeat)
  const removeBeat = useStore((s) => s.removeBeat)
  const planRemoveBeat = useStore((s) => s.planRemoveBeat)

  const [adding, setAdding] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [openBeat, setOpenBeat] = useState<{
    id: string
    title: string
    label: string | null
    note: string
    fileName: string
    empty: boolean
  } | null>(null)
  const [removing, setRemoving] = useState<
    { id: string; title: string; plan: RemoveBeatPlan } | null
  >(null)
  const [drag, setDrag] = useState<DragState | null>(null)
  const [dropAt, setDropAt] = useState<{ episodeId: string; index: number } | null>(null)
  const [dragEpisode, setDragEpisode] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  if (!opened) return null
  const episodes = [...opened.episodes].sort((a, b) => a.order - b.order)

  const beatsOf = (episodeId: string) =>
    opened.beats.filter((b) => b.episodeId === episodeId).sort((a, b) => a.order - b.order)

  async function drop(episodeId: string, index: number): Promise<void> {
    if (!drag || busy) return
    setBusy(true)
    try {
      await moveBeat({
        label: drag.label,
        fromEpisodeId: drag.fromEpisodeId,
        toEpisodeId: episodeId,
        toIndex: index
      })
    } finally {
      setBusy(false)
      setDrag(null)
      setDropAt(null)
    }
  }

  return (
    <div className="plot">
      {lastMove && (
        <div className={'plot-note' + (lastMove.error ? ' error' : '')}>
          <div className="pn-body">
            {lastMove.error ? (
              <span>{lastMove.error}</span>
            ) : (
              <>
                {lastMove.materialised.length > 0 && (
                  <span>
                    Wrote {lastMove.materialised.length} jump
                    {lastMove.materialised.length === 1 ? '' : 's'} to keep the story intact:{' '}
                    {lastMove.materialised.join(', ')}.
                  </span>
                )}
                {lastMove.warnings.map((w) => (
                  <span key={w} className="pn-warn">
                    {w}
                  </span>
                ))}
                {lastMove.materialised.length === 0 && lastMove.warnings.length === 0 && (
                  <span>Beat moved.</span>
                )}
              </>
            )}
          </div>
          <button className="ghost" onClick={clearLastMove}>
            &times;
          </button>
        </div>
      )}

      <div className="plot-board">
        {episodes.map((ep, epIndex) => {
          const beats = beatsOf(ep.id)
          const spans = parsed[ep.fileName]?.labels ?? []
          const isDraft = (ep.status ?? 'release') === 'draft'

          return (
            <section
              key={ep.id}
              className={'plot-col' + (dragEpisode === ep.id ? ' dragging' : '')}
              onDragOver={(e) => {
                if (dragEpisode && dragEpisode !== ep.id) e.preventDefault()
              }}
              onDrop={(e) => {
                if (!dragEpisode || dragEpisode === ep.id) return
                e.preventDefault()
                const ids = episodes.map((x) => x.id)
                const from = ids.indexOf(dragEpisode)
                ids.splice(epIndex, 0, ...ids.splice(from, 1))
                void reorderEpisodes(ids)
                setDragEpisode(null)
              }}
            >
              <header className="plot-head">
                <span
                  className="rl-grip"
                  title="Drag to reorder episodes"
                  draggable
                  onDragStart={() => setDragEpisode(ep.id)}
                  onDragEnd={() => setDragEpisode(null)}
                >
                  &#9776;
                </span>
                <button className="plot-title" onClick={() => void openEpisode(ep.fileName)}>
                  {ep.name}
                </button>
                <button
                  className={'plot-status' + (isDraft ? ' draft' : '')}
                  title={
                    isDraft
                      ? 'Draft: kept out of the game folder and out of any build. Click to release.'
                      : 'In the game. Click to make it a draft and move it out of game/.'
                  }
                  onClick={() => void setEpisodeStatus(ep.id, isDraft ? 'release' : 'draft')}
                >
                  {isDraft ? 'Draft' : 'In game'}
                </button>
              </header>

              <div className="plot-file">{ep.fileName}</div>

              <div
                className="plot-cards"
                onDragOver={(e) => {
                  if (!drag) return
                  e.preventDefault()
                  setDropAt({ episodeId: ep.id, index: beats.length })
                }}
                onDrop={(e) => {
                  if (!drag) return
                  e.preventDefault()
                  void drop(ep.id, dropAt?.episodeId === ep.id ? dropAt.index : beats.length)
                }}
              >
                {beats.map((beat, i) => {
                  const span = beat.label ? spans.find((s) => s.label === beat.label) : undefined
                  const kind = span?.endKind
                  const showLine = dropAt?.episodeId === ep.id && dropAt.index === i
                  return (
                    <div key={beat.id}>
                      {showLine && <div className="plot-drop" />}
                      <article
                        className={
                          'plot-card' +
                          (beat.label ? '' : ' unwritten') +
                          (drag?.label === beat.label ? ' dragging' : '')
                        }
                        draggable={!!beat.label}
                        onDragStart={() => {
                          if (beat.label) setDrag({ label: beat.label, fromEpisodeId: ep.id })
                        }}
                        onDragEnd={() => {
                          setDrag(null)
                          setDropAt(null)
                        }}
                        onDragOver={(e) => {
                          if (!drag) return
                          e.preventDefault()
                          e.stopPropagation()
                          setDropAt({ episodeId: ep.id, index: i })
                        }}
                        onDrop={(e) => {
                          if (!drag) return
                          e.preventDefault()
                          e.stopPropagation()
                          void drop(ep.id, i)
                        }}
                        onClick={() =>
                          setOpenBeat({
                            id: beat.id,
                            title: beat.title,
                            label: beat.label,
                            note: beat.description ?? '',
                            fileName: ep.fileName,
                            empty: span?.empty ?? !beat.label
                          })
                        }
                        // The card reads as prose; the label is what the engine
                        // actually calls this, and is worth being able to see
                        // without opening the script.
                        title={beat.label ?? 'Not written yet'}
                        data-label={beat.label ?? ''}
                      >
                        <div className="pc-title">{beatName(beat.title)}</div>
                        {beat.description && (
                          <div className="pc-note" title={beat.description}>
                            {beat.description}
                          </div>
                        )}
                        <div className="pc-meta">
                          {kind && (
                            <span className="pc-kind" style={{ color: END_COLOR[kind] }}>
                              {END_LABEL[kind] || 'jumps on'}
                            </span>
                          )}
                          {(span?.empty ?? !beat.label) && (
                            <span className="pc-kind">nothing written yet</span>
                          )}
                          <span className="spacer" />
                          <button
                            className={'pc-act' + (beat.description ? '' : ' quiet')}
                            title={beat.description ? 'Read the note' : 'Add a note'}
                            onClick={(e) => {
                              e.stopPropagation()
                              setOpenBeat({
                                id: beat.id,
                                title: beat.title,
                                label: beat.label,
                                note: beat.description ?? '',
                                fileName: ep.fileName,
                                empty: span?.empty ?? !beat.label
                              })
                            }}
                          >
                            {beat.description ? 'Note' : '+ Note'}
                          </button>
                          <button
                            className="pc-act danger quiet"
                            title={
                              !beat.label || span?.empty
                                ? 'Remove this beat'
                                : 'Remove this beat, and its lines, from the script'
                            }
                            onClick={(e) => {
                              e.stopPropagation()
                              // Nothing written, nothing to lose. The label
                              // may exist -- every beat has one now -- but an
                              // empty scene is still just a card.
                              if (!beat.label || span?.empty) {
                                void removeBeat(beat.id)
                                return
                              }
                              void planRemoveBeat(beat.id).then((plan) => {
                                if (!plan) return
                                if (plan.error) return reportError(plan.error)
                                setRemoving({ id: beat.id, title: beat.title, plan })
                              })
                            }}
                          >
                            &times;
                          </button>
                        </div>
                      </article>
                    </div>
                  )
                })}

                {dropAt?.episodeId === ep.id && dropAt.index >= beats.length && (
                  <div className="plot-drop" />
                )}
                {beats.length === 0 && <div className="plot-empty">No beats yet.</div>}

                {adding === ep.id ? (
                  <form
                    className="plot-add"
                    onSubmit={(e) => {
                      e.preventDefault()
                      const name = draft.trim()
                      if (!name) return
                      void createBeat(ep.id, name).then(() => {
                        setDraft('')
                        setAdding(null)
                      })
                    }}
                  >
                    <input
                      autoFocus
                      value={draft}
                      placeholder="What happens here?"
                      onChange={(e) => setDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Escape') {
                          setAdding(null)
                          setDraft('')
                        }
                      }}
                    />
                    <div className="plot-add-row">
                      <button type="button" onClick={() => { setAdding(null); setDraft('') }}>
                        Cancel
                      </button>
                      <button type="submit" className="primary" disabled={!draft.trim()}>
                        Add
                      </button>
                    </div>
                  </form>
                ) : (
                  <button className="plot-add-open" onClick={() => setAdding(ep.id)}>
                    + Beat
                  </button>
                )}
              </div>
            </section>
          )
        })}

        {episodes.length === 0 && (
          <div className="plot-empty">
            No episodes yet. Add one from the outline to start plotting.
          </div>
        )}
      </div>

      {openBeat && (
        <div className="modal-backdrop" onClick={() => setOpenBeat(null)}>
          <div className="modal beat-modal" onClick={(e) => e.stopPropagation()}>
            <label className="field">
              <span>Name</span>
              <input
                autoFocus
                value={openBeat.title}
                onChange={(e) => setOpenBeat({ ...openBeat, title: e.target.value })}
              />
            </label>
            <p className="hint bm-where">
              {openBeat.label ? (
                <>
                  <code>{openBeat.label}</code> in <code>{openBeat.fileName}</code>
                  {openBeat.empty && ' — nothing written yet'}
                </>
              ) : (
                'Not in the script'
              )}
            </p>

            <label className="field">
              <span>Note</span>
              <textarea
                rows={7}
                value={openBeat.note}
                placeholder="What this scene is for, before it exists."
                onChange={(e) => setOpenBeat({ ...openBeat, note: e.target.value })}
              />
            </label>
            <p className="hint">Kept with the outline, never written into the script.</p>

            <div className="actions-row">
              <button
                className="danger"
                onClick={() => {
                  const beat = openBeat
                  setOpenBeat(null)
                  // An empty scene has nothing to lose; one with words asks.
                  if (!beat.label || beat.empty) {
                    void removeBeat(beat.id)
                    return
                  }
                  void planRemoveBeat(beat.id).then((plan) => {
                    if (!plan) return
                    if (plan.error) return reportError(plan.error)
                    setRemoving({ id: beat.id, title: beat.title, plan })
                  })
                }}
              >
                Delete
              </button>
              <span className="spacer" />
              {openBeat.label && (
                <button
                  onClick={() => {
                    const file = openBeat.fileName
                    setOpenBeat(null)
                    void openEpisode(file)
                  }}
                >
                  Open in script
                </button>
              )}
              <button onClick={() => setOpenBeat(null)}>Cancel</button>
              <button
                className="primary"
                onClick={() => {
                  const beat = openBeat
                  setOpenBeat(null)
                  void updateBeat(beat.id, {
                    title: beat.title,
                    description: beat.note.trim()
                  })
                }}
              >
                Save
              </button>
            </div>
          </div>
        </div>
      )}

      {removing && (
        <RemoveBeatDialog removing={removing} onClose={() => setRemoving(null)} />
      )}

      {busy && <div className="plot-busy">Rewriting script…</div>}
    </div>
  )
}
