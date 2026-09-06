import { useState } from 'react'
import { DEFAULT_SETTINGS, type ProjectSettings, type RenpyRootCheck } from '@shared/types'
import { api } from '../api'
import { useStore } from '../state/store'

interface Props {
  busy: boolean
  onCancel: () => void
  onCreate: (input: { name: string; renpyRoot: string; settings: ProjectSettings }) => Promise<void>
  onOpenExisting: (root: string) => Promise<void>
}

/**
 * Pick a Ren'Py folder and configure a new project. Shared by the opening gate
 * and the "Add project" modal reachable while another project is open.
 */
export default function AddProjectForm({ busy, onCancel, onCreate, onOpenExisting }: Props) {
  const capabilities = useStore((st) => st.capabilities)
  const [root, setRoot] = useState('')
  const [check, setCheck] = useState<RenpyRootCheck | null>(null)
  const [alreadyAProject, setAlreadyAProject] = useState(false)
  const [name, setName] = useState('')
  const [settings, setSettings] = useState<ProjectSettings>(DEFAULT_SETTINGS)
  const [localError, setLocalError] = useState<string | null>(null)

  async function inspect(picked: string) {
    setRoot(picked)
    setLocalError(null)
    const result = await api.checkRoot(picked)
    setCheck(result)

    // A folder that already has a sidecar is opened, not re-created.
    try {
      await api.openProject(picked)
      setAlreadyAProject(true)
      return
    } catch {
      setAlreadyAProject(false)
    }

    if (result.valid) {
      const leaf = picked.split(/[\\/]/).filter(Boolean).pop() ?? 'Untitled'
      setName(leaf)
      setSettings((s) => ({
        ...s,
        scriptDir: result.scriptDirCandidates.includes('scripts')
          ? 'scripts'
          : result.scriptDirCandidates[0]
      }))
    }
  }

  async function pick() {
    const picked = await api.pickFolder()
    if (picked) await inspect(picked)
  }

  const canCreate = !!check?.valid && name.trim().length > 0 && !busy

  return (
    <div>
      <label className="field">
        <span>Ren&rsquo;Py project folder</span>
        <div className="row">
          <input
            value={root}
            placeholder="The folder that contains game/"
            onChange={(e) => setRoot(e.target.value)}
            onBlur={(e) => {
              if (e.target.value.trim()) void inspect(e.target.value.trim())
            }}
            onKeyDown={(e) => {
              // Enter as well as leaving the field: on a phone there is no
              // folder to browse to and losing focus means dismissing the
              // keyboard first, which is a strange thing to have to do.
              if (e.key === 'Enter' && e.currentTarget.value.trim()) {
                e.preventDefault()
                void inspect(e.currentTarget.value.trim())
              }
            }}
          />
          {capabilities.folderPicker && (
            <button className="none" onClick={() => void pick()}>
              Browse&hellip;
            </button>
          )}
        </div>
        {check && !check.valid && <div className="error">{check.reason}</div>}
      </label>

      {alreadyAProject && (
        <div>
          <p className="hint">
            This folder already has a Ren&rsquo;Py Writer project. Opening it instead.
          </p>
          <div className="actions-row">
            <button onClick={onCancel}>Cancel</button>
            <button className="primary" onClick={() => void onOpenExisting(root)}>
              Open project
            </button>
          </div>
        </div>
      )}

      {check?.valid && !alreadyAProject && (
        <>
          <label className="field">
            <span>Project name</span>
            <input value={name} onChange={(e) => setName(e.target.value)} />
          </label>

          <label className="field">
            <span>Script folder</span>
            <select
              value={settings.scriptDir}
              onChange={(e) => setSettings({ ...settings, scriptDir: e.target.value })}
            >
              {check.scriptDirCandidates.map((c) => (
                <option key={c} value={c}>
                  {c === '' ? 'game/' : `game/${c}/`}
                </option>
              ))}
            </select>
            <div className="hint">Where episode .rpy files live.</div>
          </label>

          <div className="row">
            <label className="field">
              <span>Written in</span>
              <input
                value={settings.sourceLanguage}
                onChange={(e) => setSettings({ ...settings, sourceLanguage: e.target.value })}
              />
            </label>
            <label className="field">
              <span>Translate to</span>
              <input
                value={settings.targetLanguage}
                onChange={(e) => setSettings({ ...settings, targetLanguage: e.target.value })}
              />
            </label>
          </div>

          <label className="check">
            <input
              type="checkbox"
              checked={settings.expressionsEnabled}
              onChange={(e) => setSettings({ ...settings, expressionsEnabled: e.target.checked })}
            />
            <span>Uses character expressions (side portraits)</span>
          </label>

          <label className="check">
            <input
              type="checkbox"
              checked={settings.linear}
              onChange={(e) => setSettings({ ...settings, linear: e.target.checked })}
            />
            <span>Linear story</span>
          </label>
          <div className="hint">
            Linear keeps each label&rsquo;s trailing jump pointed at the next beat. Non-linear only
            adds a jump when one is missing, and never rewrites branching control flow.
          </div>

          {localError && <div className="error">{localError}</div>}

          <div className="actions-row">
            <button onClick={onCancel}>Cancel</button>
            <button
              className="primary"
              disabled={!canCreate}
              onClick={async () => {
                try {
                  await onCreate({ name: name.trim(), renpyRoot: root, settings })
                } catch (e) {
                  setLocalError(e instanceof Error ? e.message : String(e))
                }
              }}
            >
              Create project
            </button>
          </div>
        </>
      )}

      {!check && (
        <div className="actions-row">
          <button onClick={onCancel}>Cancel</button>
        </div>
      )}
    </div>
  )
}
