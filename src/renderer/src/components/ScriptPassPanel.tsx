import { useEffect, useState } from 'react'
import type { LineChange, PassMode } from '@shared/api'
import { useStore } from '../state/store'

interface Props {
  mode: PassMode
  fileName: string
  /** Line range of the beat under the caret, if any. */
  beat: { label: string; from: number; to: number } | null
  onClose: () => void
}

/**
 * Translate or proofread the dialogue in the open script.
 *
 * Both passes propose changes to a file the writer has been working in, and
 * nothing is written until the changes are approved. Approving all of them is
 * one click, because most of the time that is the answer; but an editing pass
 * makes judgement calls, and one call somebody disagrees with should cost them
 * that line rather than the whole pass.
 */
export default function ScriptPassPanel({ mode, fileName, beat, onClose }: Props) {
  const opened = useStore((s) => s.opened)
  const pass = useStore((s) => s.pass)
  const runScriptPass = useStore((s) => s.runScriptPass)
  const applyPass = useStore((s) => s.applyPass)
  const revertPass = useStore((s) => s.revertPass)
  const clearPass = useStore((s) => s.clearPass)

  const [scope, setScope] = useState<'file' | 'beat'>(beat ? 'beat' : 'file')
  /** Lines to write, by line number. Everything the pass found, to begin with. */
  const [approved, setApproved] = useState<Set<number>>(new Set())

  const proposed = pass?.changes
  useEffect(() => {
    setApproved(new Set((proposed ?? []).map((c) => c.line)))
  }, [proposed])

  if (!opened) return null
  const { sourceLanguage, targetLanguage } = opened.project.settings
  const running = pass?.running === true
  const done = pass && !pass.running
  const proofing = mode === 'proofread'

  const changes: LineChange[] = pass?.changes ?? []
  const picked = changes.filter((c) => approved.has(c.line))

  function toggle(line: number): void {
    setApproved((was) => {
      const next = new Set(was)
      if (next.has(line)) next.delete(line)
      else next.add(line)
      return next
    })
  }

  function start(): void {
    const lines =
      scope === 'beat' && beat
        ? Array.from({ length: beat.to - beat.from + 1 }, (_, i) => beat.from + i)
        : undefined
    void runScriptPass(mode, fileName, lines)
  }

  return (
    <div
      className="modal-backdrop"
      onClick={() => {
        if (!running) {
          clearPass()
          onClose()
        }
      }}
    >
      <div className="modal pass-modal" onClick={(e) => e.stopPropagation()}>
        <h2>
          {proofing ? (
            <>Proofread {targetLanguage}</>
          ) : (
            <>
              Translate {sourceLanguage} &rarr; {targetLanguage}
            </>
          )}
        </h2>

        {!done && (
          <>
            <div className="seg-choice">
              <button
                className={scope === 'file' ? 'on' : ''}
                disabled={running}
                onClick={() => setScope('file')}
              >
                <span className="t">Whole episode</span>
                <span className="d">{fileName}</span>
              </button>
              <button
                className={scope === 'beat' ? 'on' : ''}
                disabled={running || !beat}
                onClick={() => setScope('beat')}
              >
                <span className="t">This beat</span>
                <span className="d">
                  {beat ? `${beat.label} (lines ${beat.from}–${beat.to})` : 'No beat at the caret'}
                </span>
              </button>
            </div>

            <p className="hint">
              {proofing ? (
                <>
                  Only dialogue and menu choices are read. Spelling, grammar and punctuation are
                  corrected, and lines that read stiffly, pad, or repeat a word from a line or two
                  ago are edited to sound spoken. Lines still in {sourceLanguage} are left for the
                  translation pass, and each character&rsquo;s accent goes along so their voice is
                  not tidied away. Every change says what it was for.
                </>
              ) : (
                <>
                  Only dialogue and menu choices are sent. Lines that already read as{' '}
                  {targetLanguage} are skipped, and each character&rsquo;s accent is passed along so
                  their voice carries over.
                </>
              )}
            </p>

            <div className="actions-row">
              <button disabled={running} onClick={onClose}>
                Cancel
              </button>
              <button className="primary" disabled={running} onClick={start}>
                {proofing ? 'Proofread' : 'Translate'}
              </button>
            </div>
          </>
        )}

        {running && (
          <div className="tr-running">
            Waiting for the {proofing ? 'proofreader' : 'translator'}&hellip;
          </div>
        )}

        {done && pass.error && (
          <>
            <div className="error">{pass.error}</div>
            <p className="hint">
              The script was not changed. If the CLI is missing, install it with{' '}
              <code>npm install -g @anthropic-ai/claude-code</code>; if it is not signed in, run{' '}
              <code>claude auth login</code>. You can also point at a different command in project
              settings.
            </p>
            <div className="actions-row">
              <button
                onClick={() => {
                  clearPass()
                  onClose()
                }}
              >
                Close
              </button>
            </div>
          </>
        )}

        {done && !pass.error && !pass.applied && (
          <>
            <div className="tr-summary">
              {changes.length} line{changes.length === 1 ? '' : 's'}{' '}
              {pass.mode === 'proofread' ? 'to correct' : 'to translate'}
              {pass.skipped > 0 &&
                (pass.mode === 'proofread'
                  ? `, ${pass.skipped} still in ${sourceLanguage}`
                  : `, ${pass.skipped} already in ${targetLanguage}`)}
              . Nothing is written until you say so.
            </div>

            {changes.length > 0 && (
              <div className="tr-pick">
                <span className="tr-count">
                  {picked.length} of {changes.length} approved
                </span>
                <button onClick={() => setApproved(new Set(changes.map((c) => c.line)))}>
                  Approve all
                </button>
                <button onClick={() => setApproved(new Set())}>Reject all</button>
              </div>
            )}

            <ul className="tr-changes">
              {changes.map((c) => (
                <li key={c.line} className={approved.has(c.line) ? '' : 'rejected'}>
                  <label className="tc-head">
                    <input
                      type="checkbox"
                      className="tc-pick"
                      checked={approved.has(c.line)}
                      onChange={() => toggle(c.line)}
                    />
                    <span className="tc-line">Ln {c.line}</span>
                    {c.speaker && <span className="tc-speaker">{c.speaker}</span>}
                  </label>
                  <div className="tc-before">{c.before}</div>
                  <div className="tc-after">{c.after}</div>
                  {c.why && <div className="tc-why">{c.why}</div>}
                </li>
              ))}
              {changes.length === 0 && (
                <li className="tr-none">
                  {pass.mode === 'proofread'
                    ? 'Nothing to correct. Every line read clean.'
                    : `Nothing needed translating. Every line already reads as ${targetLanguage}.`}
                </li>
              )}
            </ul>

            <div className="actions-row">
              <button
                onClick={() => {
                  clearPass()
                  onClose()
                }}
              >
                {changes.length === 0 ? 'Close' : 'Discard'}
              </button>
              {changes.length > 0 && (
                <button
                  className="primary"
                  disabled={picked.length === 0}
                  onClick={() => void applyPass(picked)}
                >
                  Apply {picked.length} change{picked.length === 1 ? '' : 's'}
                </button>
              )}
            </div>
          </>
        )}

        {done && !pass.error && pass.applied && (
          <>
            <div className="tr-summary">
              {pass.applied.count} change{pass.applied.count === 1 ? '' : 's'} written to{' '}
              <code>{pass.fileName}</code>.
            </div>
            {pass.applied.missed.length > 0 && (
              <>
                <p className="hint">
                  {pass.applied.missed.length} could not be applied: those lines had been edited
                  since the pass read them, so they were left as they are.
                </p>
                <ul className="tr-changes">
                  {pass.applied.missed.map((c) => (
                    <li key={c.line} className="rejected">
                      <div className="tc-head">
                        <span className="tc-line">Ln {c.line}</span>
                      </div>
                      <div className="tc-after">{c.after}</div>
                    </li>
                  ))}
                </ul>
              </>
            )}
            <div className="actions-row">
              <button
                onClick={() => {
                  void revertPass()
                  onClose()
                }}
              >
                Put it all back
              </button>
              <button
                className="primary"
                onClick={() => {
                  clearPass()
                  onClose()
                }}
              >
                Done
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
