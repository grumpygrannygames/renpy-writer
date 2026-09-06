import { useMemo, useState } from 'react'
import type { ConflictRegion, Decision, FileConflict, Take } from '@shared/api'
import type { ScriptNode } from '@shared/renpy/document'

/**
 * Choosing between two versions of the same lines.
 *
 * Deliberately not a diff. A diff asks somebody to read two columns of
 * punctuation and assemble the result in their head, which is a reasonable
 * thing to ask about code and a poor thing to ask about a line Leon says. The
 * document model already knows what each line is -- who speaks it, whether it
 * is a stage direction, whether it is staging the editor does not model -- so
 * the question can be put in those terms instead: this reads two ways, which
 * do you want.
 */

const KIND_LABEL: Record<string, string> = {
  dialogue: 'Dialogue',
  choice: 'Menu choice',
  action: 'Stage direction',
  label: 'Scene label',
  raw: 'Staging',
  blank: 'Blank line'
}

/** What a Ren'Py statement is doing, for the ones worth naming. */
function gloss(line: string): string | null {
  const words = line.trim().split(/\s+/)
  const [head, subject] = words
  const at = words.indexOf('at')
  const where = at !== -1 ? words.slice(at + 1).join(' ').replace(/:$/, '') : null

  if (head === 'show' && subject) {
    return where ? `${subject} on screen, ${where}` : `${subject} on screen`
  }
  if (head === 'hide' && subject) return `${subject} leaves`
  if (head === 'scene') return subject ? `The scene becomes ${subject}` : 'The scene changes'
  if (head === 'play' && subject) return `${subject} starts playing`
  if (head === 'stop' && subject) return `${subject} stops`
  if (head === 'with' && subject) return `A ${subject} transition`
  return null
}

/** One side of a disagreement, shown the way the editor would show it. */
function Lines({ nodes, lines }: { nodes: ScriptNode[]; lines: string[] }) {
  if (lines.length === 0) {
    return <p className="cf-empty">Nothing here &mdash; these lines were removed.</p>
  }
  return (
    <>
      {nodes.map((node, i) => {
        const source = lines[i] ?? ''
        if (node.kind === 'dialogue') {
          return (
            <p key={node.id} className="cf-line">
              {node.speaker && <span className="cf-speaker">{node.speaker}</span>}
              <span className="cf-said">{node.text}</span>
            </p>
          )
        }
        if (node.kind === 'action') {
          return (
            <p key={node.id} className="cf-line cf-action">
              {node.text}
            </p>
          )
        }
        if (node.kind === 'choice') {
          return (
            <p key={node.id} className="cf-line cf-choice">
              &ldquo;{node.text}&rdquo;
            </p>
          )
        }
        if (node.kind === 'blank') return <p key={node.id} className="cf-line cf-blank" />
        // Staging and anything else the editor does not model: the line
        // itself, because that is what will be written back, plus a plain
        // reading of it only when it is one worth trusting.
        const said = gloss(source)
        return (
          <p key={node.id} className="cf-line">
            <code className="cf-code">{source.trim()}</code>
            {said && <span className="cf-gloss">{said}</span>}
          </p>
        )
      })}
    </>
  )
}

function RegionCard({
  region,
  decision,
  onDecide
}: {
  region: ConflictRegion
  decision: Decision | undefined
  onDecide: (take: Take, text?: string) => void
}) {
  const [writing, setWriting] = useState(false)
  const [draft, setDraft] = useState(() => region.mine.lines.join('\n'))

  const kinds = [...new Set(region.mine.nodes.concat(region.theirs.nodes).map((n) => n.kind))]
  const heading = kinds.length === 1 ? (KIND_LABEL[kinds[0]] ?? 'Lines') : 'Lines'
  const take = decision?.take

  return (
    <div className={'cf-card' + (take ? ' settled' : '')}>
      <div className="cf-head">
        <span className="cf-where">
          {region.file.split('/').pop()} &middot; line {region.line}
        </span>
        <span className="cf-kind">{heading}</span>
      </div>

      <button
        type="button"
        className={'cf-side' + (take === 'mine' ? ' chosen' : '')}
        onClick={() => onDecide('mine')}
      >
        <span className="cf-who yours">Yours</span>
        <Lines nodes={region.mine.nodes} lines={region.mine.lines} />
      </button>

      <button
        type="button"
        className={'cf-side' + (take === 'theirs' ? ' chosen' : '')}
        onClick={() => onDecide('theirs')}
      >
        <span className="cf-who">Theirs</span>
        <Lines nodes={region.theirs.nodes} lines={region.theirs.lines} />
      </button>

      {writing ? (
        <div className="cf-write">
          <textarea
            value={draft}
            spellCheck={false}
            rows={Math.min(8, Math.max(2, draft.split('\n').length))}
            onChange={(e) => setDraft(e.target.value)}
          />
          <div className="cf-write-row">
            <button type="button" onClick={() => setWriting(false)}>
              Cancel
            </button>
            <button
              type="button"
              className="primary"
              onClick={() => {
                onDecide('custom', draft)
                setWriting(false)
              }}
            >
              Use this
            </button>
          </div>
        </div>
      ) : (
        <div className="cf-actions">
          {take === 'custom' && <span className="cf-own">Your own wording</span>}
          <button type="button" className="ghost" onClick={() => setWriting(true)}>
            {take === 'custom' ? 'Edit again' : 'Write my own'}
          </button>
        </div>
      )}
    </div>
  )
}

export default function ConflictPanel({
  conflicts,
  busy,
  onCancel,
  onApply
}: {
  conflicts: FileConflict[]
  busy: boolean
  onCancel: () => void
  onApply: (decisions: Decision[]) => void
}) {
  const [decisions, setDecisions] = useState<Map<string, Decision>>(new Map())
  const key = (file: string, index: number): string => `${file}:${index}`

  const regions = useMemo(
    () => conflicts.flatMap((f) => f.regions.map((r) => ({ ...r, file: f.file }))),
    [conflicts]
  )
  const settled = regions.filter((r) => decisions.has(key(r.file, r.index))).length
  const all = settled === regions.length && regions.length > 0

  const decide = (file: string, index: number, take: Take, text?: string): void => {
    setDecisions((current) => {
      const next = new Map(current)
      next.set(key(file, index), { file, index, take, text })
      return next
    })
  }

  return (
    <div className="modal-backdrop" onClick={() => !busy && onCancel()}>
      <div className="modal conflict-modal" onClick={(e) => e.stopPropagation()}>
        <h2>Two versions of the same lines</h2>
        <p className="hint">
          These were changed here and elsewhere at the same time. Nothing has been changed yet
          &mdash; nothing is written until every one is settled.
        </p>

        <div className="cf-list">
          {regions.map((region) => (
            <RegionCard
              key={key(region.file, region.index)}
              region={region}
              decision={decisions.get(key(region.file, region.index))}
              onDecide={(take, text) => decide(region.file, region.index, take, text)}
            />
          ))}
        </div>

        <div className="actions-row">
          <span className="cf-count">
            {settled} of {regions.length} settled
          </span>
          <button disabled={busy} onClick={onCancel}>
            Leave it for now
          </button>
          <button
            className="primary"
            disabled={!all || busy}
            onClick={() => onApply([...decisions.values()])}
          >
            {busy ? 'Bringing in…' : 'Bring in changes'}
          </button>
        </div>
      </div>
    </div>
  )
}
