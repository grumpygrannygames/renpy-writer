import { useCallback, useEffect, useMemo, useState } from 'react'
import type {
  Decision,
  GitChange,
  GitChangeGroup,
  GitResult,
  GitStatus
} from '@shared/api'
import { useStore } from '../state/store'
import ConflictPanel from './ConflictPanel'
import { api } from '../api'

const GROUP_LABEL: Record<GitChangeGroup, string> = {
  script: 'Scripts',
  reference: 'Characters, notes and outline',
  image: 'Images',
  audio: 'Audio',
  other: 'Other files'
}

/** Groups in the order a writer thinks about them. */
const GROUP_ORDER: GitChangeGroup[] = ['script', 'reference', 'image', 'audio', 'other']

const STATE_LABEL: Record<GitChange['state'], string> = {
  modified: 'changed',
  added: 'added',
  deleted: 'deleted',
  renamed: 'renamed',
  untracked: 'new',
  conflicted: 'conflicted'
}

/**
 * Saving work so other machines can see it, and taking in theirs.
 *
 * Deliberately not a git client. There are no branches, no staging area and no
 * history here, because none of those are things a writer wants to think about
 * mid-scene. There is what changed, a sentence about why, and a button.
 */
export default function SyncPanel({ onClose }: { onClose: () => void }) {
  const opened = useStore((s) => s.opened)
  const root = opened?.project.renpyRoot

  const [status, setStatus] = useState<GitStatus | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [outcome, setOutcome] = useState<GitResult | null>(
    null
  )

  const refresh = useCallback(async () => {
    if (!root) return
    const next = await api.gitStatus(root)
    setStatus(next)
    // Everything is selected to begin with: the common case is saving the lot.
    setSelected(new Set(next.changes.map((c) => c.path)))
  }, [root])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const grouped = useMemo(() => {
    const byGroup = new Map<GitChangeGroup, GitChange[]>()
    for (const change of status?.changes ?? []) {
      const list = byGroup.get(change.group) ?? []
      list.push(change)
      byGroup.set(change.group, list)
    }
    return GROUP_ORDER.filter((g) => byGroup.has(g)).map((g) => [g, byGroup.get(g)!] as const)
  }, [status])

  // A disagreement is not an error to read and dismiss: it is a question,
  // and it takes over until it is answered or set down.
  if (outcome?.conflicts && root) {
    return (
      <ConflictPanel
        conflicts={outcome.conflicts}
        busy={busy === 'resolve'}
        onCancel={() => setOutcome(null)}
        onApply={(decisions: Decision[]) =>
          void act('resolve', () => api.gitResolvePull(root, decisions))
        }
      />
    )
  }

  if (!opened || !root) return null

  function toggle(path: string): void {
    setSelected((current) => {
      const next = new Set(current)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  function toggleGroup(changes: GitChange[]): void {
    const allOn = changes.every((c) => selected.has(c.path))
    setSelected((current) => {
      const next = new Set(current)
      for (const c of changes) {
        if (allOn) next.delete(c.path)
        else next.add(c.path)
      }
      return next
    })
  }

  async function act(what: string, run: () => Promise<GitResult>) {
    setBusy(what)
    setOutcome(null)
    try {
      setOutcome(await run())
    } catch (e) {
      setOutcome({ ok: false, message: e instanceof Error ? e.message : String(e) })
    } finally {
      setBusy(null)
      await refresh()
    }
  }

  const nothingTracked = status?.isRepo === false
  const conflicted = (status?.conflicted.length ?? 0) > 0
  const canSave = selected.size > 0 && message.trim().length > 0 && !busy && !conflicted

  return (
    <div className="modal-backdrop" onClick={() => !busy && onClose()}>
      <div className="modal sync-modal" onClick={(e) => e.stopPropagation()}>
        <h2>Sync</h2>

        {nothingTracked ? (
          <>
            <div className="error">{status?.error}</div>
            <p className="hint">
              Syncing needs the project folder to be a git repository with a remote. Once it is,
              this panel keeps your machines in step without you running git commands.
            </p>
          </>
        ) : (
          <>
            <div className="sync-branch">
              <span className="sb-branch">{status?.branch ?? 'detached'}</span>
              {status?.upstream ? (
                <>
                  <span className="sb-arrow">&rarr;</span>
                  <span className="sb-upstream">{status.upstream}</span>
                  {/* Ahead means two quite different things. Work nobody has seen
                      needs sending; work sitting in a merge request needs
                      somebody to look at it, and saying "to send" about that
                      invites a push that would do nothing. */}
                  {status.ahead > 0 && (
                    <span className={'sb-count ' + (status.awaitingReview ? 'review' : 'ahead')}>
                      {status.awaitingReview
                        ? `${status.ahead} up for review`
                        : `${status.ahead} to send`}
                    </span>
                  )}
                  {status.behind > 0 && (
                    <span className="sb-count behind">{status.behind} to bring in</span>
                  )}
                  {status.ahead === 0 && status.behind === 0 && (
                    <span className="sb-count even">in step</span>
                  )}
                </>
              ) : (
                <span className="sb-count">not tracking a remote</span>
              )}
              <span className="spacer" />
              <button
                className="ghost"
                disabled={!!busy || !status?.upstream}
                onClick={() => void act('pull', () => api.gitPull(root))}
              >
                {busy === 'pull' ? 'Bringing in…' : 'Bring in changes'}
              </button>
            </div>

            {status?.awaitingReview && (
              <p className="hint sb-review">
                Waiting on {status.awaitingReview.split('/').slice(1).join('/')}, which is up for
                review. Saving more here adds to the same review.
              </p>
            )}

            {conflicted && (
              <div className="error">
                {status?.conflicted.length} file
                {status?.conflicted.length === 1 ? ' has' : 's have'} conflicting edits from two
                machines. Those need settling in a git client before anything else can be saved —
                the app will not guess which version to keep.
              </div>
            )}

            {status && status.changes.length === 0 ? (
              <p className="rs-none">Nothing has changed since the last save.</p>
            ) : (
              <ul className="sync-groups">
                {grouped.map(([group, changes]) => (
                  <li key={group}>
                    <div className="sg-head">
                      <input
                        type="checkbox"
                        checked={changes.every((c) => selected.has(c.path))}
                        onChange={() => toggleGroup(changes)}
                      />
                      <span className="sg-name">{GROUP_LABEL[group]}</span>
                      <span className="sg-count">{changes.length}</span>
                    </div>
                    <ul className="sg-files">
                      {changes.slice(0, 40).map((c) => (
                        <li key={c.path}>
                          <input
                            type="checkbox"
                            checked={selected.has(c.path)}
                            onChange={() => toggle(c.path)}
                          />
                          <span className={'sg-state ' + c.state}>{STATE_LABEL[c.state]}</span>
                          <span className="sg-path" title={c.path}>
                            <span className="sg-dir">{c.path.slice(0, c.path.lastIndexOf('/') + 1)}</span>
                            <span className="sg-file">{c.path.slice(c.path.lastIndexOf('/') + 1)}</span>
                          </span>
                        </li>
                      ))}
                      {changes.length > 40 && (
                        <li className="sg-more">and {changes.length - 40} more</li>
                      )}
                    </ul>
                  </li>
                ))}
              </ul>
            )}

            {status && status.changes.length > 0 && (
              <label className="field">
                <span>What changed?</span>
                <input
                  value={message}
                  placeholder="Chapter 9 part 2 renders and dialogue fixes"
                  onChange={(e) => setMessage(e.target.value)}
                />
              </label>
            )}
          </>
        )}

        {outcome && (
          <div className={outcome.ok ? 'sync-ok' : 'error'}>
            {outcome.message}
            {/* The URL was printed by the remote, so it is offered rather than
                followed, and only when it is plainly a web address. */}
            {outcome.link && /^https?:\/\//i.test(outcome.link.url) && (
              <a
                className="sync-link"
                href={outcome.link.url}
                target="_blank"
                rel="noreferrer noopener"
              >
                {outcome.link.label}
              </a>
            )}
            {outcome.detail && <pre className="sync-detail">{outcome.detail}</pre>}
          </div>
        )}

        <div className="actions-row">
          <button disabled={!!busy} onClick={onClose}>
            Close
          </button>
          {(status?.ahead ?? 0) > 0 && !status?.awaitingReview && (
            <button
              disabled={!!busy}
              onClick={() => void act('push', () => api.gitPush(root))}
            >
              {busy === 'push' ? 'Sending…' : `Send ${status?.ahead} waiting`}
            </button>
          )}
          <button
            className="primary"
            disabled={!canSave}
            onClick={() =>
              void act('commit', () =>
                api.gitCommit(root, {
                  message,
                  paths: [...selected],
                  push: true
                })
              ).then(() => setMessage(''))
            }
          >
            {busy === 'commit'
              ? 'Saving…'
              : `Save and send ${selected.size} file${selected.size === 1 ? '' : 's'}`}
          </button>
        </div>
      </div>
    </div>
  )
}
