import { useState } from 'react'
import type { PassMode } from '@shared/api'
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
 * Both passes rewrite lines in a file the writer has been working in, so the
 * result is reviewable and revertible: it shows exactly what changed and
 * offers to put it back before anything else happens.
 */
export default function ScriptPassPanel({ mode, fileName, beat, onClose }: Props) {
  const opened = useStore((s) => s.opened)
  const pass = useStore((s) => s.pass)
  const runScriptPass = useStore((s) => s.runScriptPass)
  const revertPass = useStore((s) => s.revertPass)
  const clearPass = useStore((s) => s.clearPass)

  const [scope, setScope] = useState<'file' | 'beat'>(beat ? 'beat' : 'file')

  if (!opened) return null
  const { sourceLanguage, targetLanguage } = opened.project.settings
  const running = pass?.running === true
  const done = pass && !pass.running
  const proofing = mode === 'proofread'

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
                  corrected; lines still in {sourceLanguage} are left for the translation pass, and
                  each character&rsquo;s accent goes along so their voice is not tidied away.
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

        {done && !pass.error && (
          <>
            <div className="tr-summary">
              {pass.changes.length} line{pass.changes.length === 1 ? '' : 's'}{' '}
              {pass.mode === 'proofread' ? 'corrected' : 'translated'}
              {pass.skipped > 0 &&
                (pass.mode === 'proofread'
                  ? `, ${pass.skipped} still in ${sourceLanguage}`
                  : `, ${pass.skipped} already in ${targetLanguage}`)}
              .
            </div>

            <ul className="tr-changes">
              {pass.changes.map((c) => (
                <li key={c.line}>
                  <div className="tc-head">
                    <span className="tc-line">Ln {c.line}</span>
                    {c.speaker && <span className="tc-speaker">{c.speaker}</span>}
                  </div>
                  <div className="tc-before">{c.before}</div>
                  <div className="tc-after">{c.after}</div>
                </li>
              ))}
              {pass.changes.length === 0 && (
                <li className="tr-none">
                  {pass.mode === 'proofread'
                    ? 'Nothing to correct. Every line read clean.'
                    : `Nothing needed translating. Every line already reads as ${targetLanguage}.`}
                </li>
              )}
            </ul>

            <div className="actions-row">
              {pass.changes.length > 0 && (
                <button
                  onClick={() => {
                    void revertPass()
                    onClose()
                  }}
                >
                  Put it back
                </button>
              )}
              <button
                className="primary"
                onClick={() => {
                  clearPass()
                  onClose()
                }}
              >
                Keep
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
