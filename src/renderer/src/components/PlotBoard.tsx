import { useState } from 'react'
import type { LabelEndKind } from '@shared/types'
import { useStore } from '../state/store'

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
  const lastMove = useStore((s) => s.lastMove)
  const clearLastMove = useStore((s) => s.clearLastMove)

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
                        onClick={() => void openEpisode(ep.fileName)}
                      >
                        <div className="pc-title">{beat.title}</div>
                        <div className="pc-meta">
                          {kind && (
                            <span className="pc-kind" style={{ color: END_COLOR[kind] }}>
                              {END_LABEL[kind] || 'jumps on'}
                            </span>
                          )}
                          {!beat.label && <span className="pc-kind">not written</span>}
                        </div>
                      </article>
                    </div>
                  )
                })}

                {dropAt?.episodeId === ep.id && dropAt.index >= beats.length && (
                  <div className="plot-drop" />
                )}
                {beats.length === 0 && <div className="plot-empty">No beats yet.</div>}
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

      {busy && <div className="plot-busy">Rewriting script…</div>}
    </div>
  )
}
