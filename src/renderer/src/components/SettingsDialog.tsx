import { useState } from 'react'
import type { ProjectSettings } from '@shared/types'
import { useStore } from '../state/store'

export default function SettingsDialog({ onClose }: { onClose: () => void }) {
  const opened = useStore((s) => s.opened)
  const saveSettings = useStore((s) => s.saveSettings)

  const [settings, setSettings] = useState<ProjectSettings>(
    opened?.project.settings ?? {
      sourceLanguage: 'cs',
      targetLanguage: 'en',
      expressionsEnabled: false,
      linear: true,
      scriptDir: 'scripts'
    }
  )
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (!opened) return null
  const patch = (p: Partial<ProjectSettings>) => setSettings((s) => ({ ...s, ...p }))

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Project settings</h2>

        <label className="field">
          <span>Script folder (relative to game/)</span>
          <input
            value={settings.scriptDir}
            placeholder="scripts"
            onChange={(e) => patch({ scriptDir: e.target.value.replace(/^\/+|\/+$/g, '') })}
          />
          <div className="hint">
            Leave empty if episode files sit directly in game/. Changing this after episodes exist
            will make them look missing until the files are moved.
          </div>
        </label>

        <div className="row">
          <label className="field">
            <span>Written in</span>
            <input
              value={settings.sourceLanguage}
              onChange={(e) => patch({ sourceLanguage: e.target.value })}
            />
          </label>
          <label className="field">
            <span>Translate to</span>
            <input
              value={settings.targetLanguage}
              onChange={(e) => patch({ targetLanguage: e.target.value })}
            />
          </label>
        </div>

        <label className="check">
          <input
            type="checkbox"
            checked={settings.expressionsEnabled}
            onChange={(e) => patch({ expressionsEnabled: e.target.checked })}
          />
          <span>Uses character expressions (side portraits)</span>
        </label>

        <label className="check">
          <input
            type="checkbox"
            checked={settings.linear}
            onChange={(e) => patch({ linear: e.target.checked })}
          />
          <span>Linear story</span>
        </label>
        <div className="hint">
          Linear keeps each label&rsquo;s trailing jump pointed at the next beat. Non-linear only
          adds a jump when one is missing, and never rewrites branching control flow. Either way, a
          label ending in a menu, return or if block is left alone.
        </div>

        <div className="row">
          <label className="field">
            <span>Render encoder</span>
            <select
              value={settings.renderEncoder ?? 'builtin'}
              onChange={(e) => patch({ renderEncoder: e.target.value as 'builtin' | 'ffmpeg' })}
            >
              <option value="builtin">Built in — nothing to install</option>
              <option value="ffmpeg">ffmpeg</option>
            </select>
          </label>
          <label className="field">
            <span>Render quality</span>
            <input
              type="number"
              min={1}
              max={100}
              value={settings.renderQuality ?? 100}
              onChange={(e) => patch({ renderQuality: Number(e.target.value) })}
            />
          </label>
        </div>

        {(settings.renderEncoder ?? 'builtin') === 'ffmpeg' && (
          <label className="field">
            <span>ffmpeg command or path</span>
            <input
              value={settings.ffmpegPath ?? ''}
              placeholder="ffmpeg"
              onChange={(e) => patch({ ffmpegPath: e.target.value })}
            />
          </label>
        )}

        <div className="hint">
          The built-in encoder is the one inside the app itself, so renders convert on a fresh
          install with nothing downloaded, and transparency survives. Measured against a finished
          1920&times;1080 render it matches ffmpeg to within a fraction of a decibel. Quality is
          libwebp&rsquo;s lossy scale: 100 keeps the fidelity of a finished render at about a
          twelfth of the PNG size, and lower values fall away quickly on soft gradients.
        </div>

        {error && <div className="error">{error}</div>}

        <div className="actions-row">
          <button onClick={onClose}>Cancel</button>
          <button
            className="primary"
            disabled={busy}
            onClick={async () => {
              setBusy(true)
              setError(null)
              try {
                await saveSettings(settings)
                onClose()
              } catch (e) {
                setError(e instanceof Error ? e.message : String(e))
              } finally {
                setBusy(false)
              }
            }}
          >
            Save
          </button>
        </div>
      </div>
    </div>
  )
}
