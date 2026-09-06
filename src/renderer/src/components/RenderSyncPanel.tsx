import { useCallback, useEffect, useRef, useState } from 'react'
import type { ConvertedItem, FfmpegStatus, RenderPlan } from '@shared/api'
import type { Episode } from '@shared/types'
import { useStore } from '../state/store'
import { api } from '../api'

/** Conversions per IPC round trip. Small enough that progress keeps moving. */
const BATCH = 4

function kb(bytes: number | undefined): string {
  if (bytes === undefined) return '—'
  return bytes >= 1024 * 1024
    ? (bytes / (1024 * 1024)).toFixed(1) + ' MB'
    : Math.round(bytes / 1024) + ' KB'
}

/**
 * Bring an episode's rendered stills into the game.
 *
 * The plan is shown before anything is written, and only what is missing or
 * out of date is offered: a chapter is hundreds of images and re-encoding all
 * of them every time would take minutes and churn the repository for nothing.
 */
export default function RenderSyncPanel({
  episode,
  onClose
}: {
  episode: Episode
  onClose: () => void
}) {
  const setEpisodeRenders = useStore((s) => s.setEpisodeRenders)
  const saveSettings = useStore((s) => s.saveSettings)
  const opened = useStore((s) => s.opened)
  const capabilities = useStore((s) => s.capabilities)

  const [sourceDir, setSourceDir] = useState(episode.renders?.sourceDir ?? '')
  const [targetSubdir, setTargetSubdir] = useState(episode.renders?.targetSubdir ?? '')
  const [includeSubfolders, setIncludeSubfolders] = useState(
    episode.renders?.includeSubfolders ?? false
  )
  const [plan, setPlan] = useState<RenderPlan | null>(null)
  const [scanning, setScanning] = useState(false)
  const [done, setDone] = useState<ConvertedItem[] | null>(null)
  const [progress, setProgress] = useState<{ at: number; of: number } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [encoder, setEncoder] = useState<FfmpegStatus | null>(null)
  const [saving, setSaving] = useState<'idle' | 'busy' | { message: string; ok: boolean }>('idle')
  const cancelled = useRef(false)

  const configured = (episode.renders?.sourceDir ?? '') !== ''
  const dirty =
    sourceDir !== (episode.renders?.sourceDir ?? '') ||
    targetSubdir !== (episode.renders?.targetSubdir ?? '') ||
    includeSubfolders !== (episode.renders?.includeSubfolders ?? false)

  const scan = useCallback(async () => {
    setScanning(true)
    setError(null)
    try {
      setPlan(await api.planRenderSync(opened!.project.renpyRoot, episode.id))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setScanning(false)
    }
  }, [episode.id, opened])

  const checkEncoder = useCallback(async () => {
    setEncoder(await api.checkFfmpeg(opened!.project.renpyRoot))
  }, [opened])

  useEffect(() => {
    if (configured) void scan()
    // Asked when the panel opens, not when Convert is pressed: a missing
    // encoder fails the same way for every image, and finding that out after
    // starting a chapter's worth of conversions helps nobody.
    void checkEncoder()
    // Only on open: rescanning is an explicit action after that.
  }, [])

  async function save(): Promise<void> {
    setError(null)
    try {
      await setEpisodeRenders(
        episode.id,
        sourceDir.trim() ? { sourceDir, targetSubdir, includeSubfolders } : null
      )
      await scan()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  async function useEncoder(command: string): Promise<void> {
    setError(null)
    try {
      await saveSettings({ ...opened!.project.settings, ffmpegPath: command })
      await checkEncoder()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  async function browse(): Promise<void> {
    const picked = await api.pickFolder()
    if (picked) setSourceDir(picked)
  }

  const outstanding = (plan?.items ?? []).filter((i) => i.status !== 'current')

  async function convert(): Promise<void> {
    if (outstanding.length === 0) return
    cancelled.current = false
    setDone(null)
    setError(null)
    const names = outstanding.map((i) => i.name)
    const results: ConvertedItem[] = []
    setProgress({ at: 0, of: names.length })

    for (let i = 0; i < names.length; i += BATCH) {
      if (cancelled.current) break
      try {
        results.push(
          ...(await api.convertRenders(
            opened!.project.renpyRoot,
            episode.id,
            names.slice(i, i + BATCH)
          ))
        )
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
        break
      }
      setProgress({ at: Math.min(i + BATCH, names.length), of: names.length })

      // A missing encoder fails identically for every file; stop at the first.
      if (results.some((r) => !r.ok && r.error?.includes('ffmpeg was not found'))) break
    }

    setProgress(null)
    setDone(results)
    setSaving('idle')
    await scan()
  }

  /**
   * Converting a chapter's renders leaves hundreds of files that no other
   * machine can see. Offering to save them here closes that gap, rather than
   * leaving it as a separate chore in another program.
   */
  async function saveConverted(paths: string[]): Promise<void> {
    setSaving('busy')
    const result = await api.gitCommit(opened!.project.renpyRoot, {
      message: `Renders for ${episode.name}: ${paths.length} image${paths.length === 1 ? '' : 's'}`,
      paths,
      push: true
    })
    setSaving({ ok: result.ok, message: result.message })
  }

  const failures = (done ?? []).filter((r) => !r.ok)
  const written = (done ?? []).filter((r) => r.ok)
  const running = progress !== null

  return (
    <div
      className="modal-backdrop"
      onClick={() => {
        if (!running) onClose()
      }}
    >
      <div className="modal renders-modal" onClick={(e) => e.stopPropagation()}>
        <h2>Renders for {episode.name}</h2>

        <div className="rs-config">
          <div className="field">
            <label htmlFor="rs-source">Render folder</label>
            <div className="rs-row">
              <input
                id="rs-source"
                value={sourceDir}
                placeholder="C:\Users\you\Documents\Blender\Project\Chapter 1\Renders"
                onChange={(e) => setSourceDir(e.target.value)}
              />
              {capabilities.folderPicker && (
                <button onClick={browse} disabled={running}>
                  Browse&hellip;
                </button>
              )}
            </div>
            <span className="rf-hint">
              {includeSubfolders
                ? 'Every folder inside is read too, and its structure is kept in the game.'
                : 'Read at the top level only. Sub-folders such as old or Animations are left alone.'}
            </span>
          </div>

          <div className="field">
            <label htmlFor="rs-target">Folder in the game</label>
            <div className="rs-row">
              <span className="rs-fixed">game/images/</span>
              <input
                id="rs-target"
                value={targetSubdir}
                placeholder="ch9"
                onChange={(e) => setTargetSubdir(e.target.value)}
              />
            </div>
            <span className="rf-hint">
              Leave empty to write straight into <code>game/images</code>.
            </span>
          </div>

          <label className="check">
            <input
              type="checkbox"
              checked={includeSubfolders}
              disabled={running}
              onChange={(e) => setIncludeSubfolders(e.target.checked)}
            />
            <span>Include sub-folders</span>
          </label>
          <span className="rf-hint">
            A render in <code>scene_a/shot_01.png</code> becomes{' '}
            <code>{(targetSubdir ? targetSubdir + '/' : '') + 'scene_a/shot_01.webp'}</code>. The
            folder is kept rather than flattened, so two scenes can each have a shot_01 without one
            overwriting the other.
          </span>

          {dirty && (
            <div className="actions-row">
              <button className="primary" onClick={save} disabled={running}>
                Save and scan
              </button>
            </div>
          )}
        </div>

        {encoder && !encoder.ok && (
          <div className="rs-encoder">
            <div className="error">{encoder.error}</div>
            {encoder.candidates.length > 0 ? (
              <>
                <p className="rf-hint">
                  These would work. Using one is a choice, not a default &mdash; they belong to
                  other programs and can move or disappear when those update. Switching the
                  encoder back to &ldquo;Built in&rdquo; in project settings needs no install at
                  all.
                </p>
                <ul className="rs-candidates">
                  {encoder.candidates.map((c) => (
                    <li key={c.command}>
                      <span className="rs-cand-label">{c.label}</span>
                      <span className="rs-name">{c.command}</span>
                      <button onClick={() => void useEncoder(c.command)}>Use this one</button>
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              <p className="rf-hint">
                Nothing usable was found on this machine. Either switch the encoder back to
                &ldquo;Built in&rdquo; in project settings, which needs no install, or install
                ffmpeg with <code>winget install Gyan.FFmpeg</code> and restart Ren&rsquo;Py
                Writer &mdash; a running program keeps the PATH it started with, so it will not
                see a new installation until it is reopened.
              </p>
            )}
            <button className="ghost" onClick={() => void checkEncoder()}>
              Look again
            </button>
          </div>
        )}

        {encoder?.ok && encoder.version && (
          <p className="rs-encoder-ok" title={encoder.command}>
            {encoder.version}
          </p>
        )}

        {error && <div className="error">{error}</div>}
        {plan?.error && !error && <div className="error">{plan.error}</div>}

        {scanning && <div className="tr-running">Scanning&hellip;</div>}

        {plan && !plan.error && !scanning && (
          <>
            <div className="rs-summary">
              <span className="rs-count new">
                {plan.items.filter((i) => i.status === 'new').length} new
              </span>
              <span className="rs-count stale">
                {plan.items.filter((i) => i.status === 'stale').length} out of date
              </span>
              <span className="rs-count current">
                {plan.items.filter((i) => i.status === 'current').length} up to date
              </span>
              {plan.ignoredDirs.length > 0 && (
                <span className="rs-count ignored" title={plan.ignoredDirs.join(', ')}>
                  {plan.ignoredDirs.length} folder
                  {plan.ignoredDirs.length === 1 ? '' : 's'} skipped
                </span>
              )}
            </div>

            {outstanding.length > 0 ? (
              <ul className="rs-list">
                {outstanding.map((item) => (
                  <li key={item.name}>
                    <span className={'rs-badge ' + item.status}>
                      {item.status === 'new' ? 'new' : 'newer'}
                    </span>
                    <span className="rs-name">{item.name}</span>
                    <span className="rs-arrow">&rarr;</span>
                    <span className="rs-out">{item.outputName}</span>
                    <span className="rs-size">{kb(item.sourceBytes)}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="rs-none">
                Every render is already in the game. Nothing to convert.
              </p>
            )}
          </>
        )}

        {running && (
          <div className="tr-running">
            Converting {progress.at} of {progress.of}&hellip;
          </div>
        )}

        {done && (
          <div className="rs-done">
            {written.length} image{written.length === 1 ? '' : 's'} written
            {written.length > 0 && ` (${kb(written.reduce((n, r) => n + (r.bytes ?? 0), 0))})`}
            {failures.length > 0 && `, ${failures.length} failed`}.
            {written.length > 0 && written.every((r) => r.repoPath) && (
              <div className="rs-save">
                {saving === 'idle' && (
                  <button
                    onClick={() =>
                      void saveConverted(written.map((r) => r.repoPath!).filter(Boolean))
                    }
                  >
                    Save these {written.length} image{written.length === 1 ? '' : 's'} so other
                    machines get them
                  </button>
                )}
                {saving === 'busy' && <span className="rf-hint">Saving&hellip;</span>}
                {typeof saving === 'object' && (
                  <span className={saving.ok ? 'rs-saved' : 'error'}>{saving.message}</span>
                )}
              </div>
            )}

            {failures.length > 0 && (
              <ul className="rs-failures">
                {failures.slice(0, 5).map((f) => (
                  <li key={f.name}>
                    <span className="rs-name">{f.name}</span>
                    <span className="rs-err">{f.error}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        <div className="actions-row">
          {running ? (
            <button
              onClick={() => {
                cancelled.current = true
              }}
            >
              Stop
            </button>
          ) : (
            <>
              <button onClick={onClose}>Close</button>
              <button onClick={scan} disabled={!configured || scanning}>
                Rescan
              </button>
              <button
                className="primary"
                onClick={convert}
                disabled={outstanding.length === 0 || dirty || encoder?.ok === false}
              >
                {outstanding.length > 0
                  ? `Convert ${outstanding.length} image${outstanding.length === 1 ? '' : 's'}`
                  : 'Nothing to convert'}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
