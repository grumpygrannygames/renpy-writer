import { useEffect, useRef, useState } from 'react'
import { isDirty, useStore } from '../state/store'

/**
 * Switch between known projects without closing the current one. Unsaved work
 * blocks the switch until confirmed, since tabs do not survive it.
 */
export default function ProjectSwitcher({ onAddProject }: { onAddProject: () => void }) {
  const opened = useStore((s) => s.opened)
  const projects = useStore((s) => s.projects)
  const tabs = useStore((s) => s.tabs)
  const openProject = useStore((s) => s.openProject)
  const refreshProjects = useStore((s) => s.refreshProjects)
  const closeProject = useStore((s) => s.closeProject)

  const [open, setOpen] = useState(false)
  const wrap = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    void refreshProjects()

    function onDown(e: MouseEvent) {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false)
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open, refreshProjects])

  if (!opened) return null

  const dirtyCount = tabs.filter(isDirty).length

  function guardUnsaved(): boolean {
    if (dirtyCount === 0) return true
    return window.confirm(
      `${dirtyCount} unsaved ${dirtyCount === 1 ? 'file' : 'files'}. Switching projects will discard those changes. Continue?`
    )
  }

  async function switchTo(root: string) {
    setOpen(false)
    if (root === opened?.project.renpyRoot) return
    if (!guardUnsaved()) return
    await openProject(root)
  }

  const others = projects.filter((p) => p.renpyRoot !== opened.project.renpyRoot)

  return (
    <div className="switcher" ref={wrap}>
      <button className="switcher-trigger" onClick={() => setOpen((o) => !o)} title="Switch project">
        <span className="switcher-name">{opened.project.name}</span>
        <span className="switcher-caret">{open ? '▲' : '▼'}</span>
      </button>

      {open && (
        <div className="popover">
          <div className="popover-label">Projects</div>

          <button className="popover-item current" disabled>
            <span className="pi-name">{opened.project.name}</span>
            <span className="pi-check">&#10003;</span>
          </button>

          {others.map((p) => (
            <button
              key={p.id}
              className="popover-item"
              title={p.renpyRoot}
              onClick={() => void switchTo(p.renpyRoot)}
            >
              <span className="pi-name">{p.name}</span>
              <span className="pi-path">{p.renpyRoot}</span>
            </button>
          ))}

          {others.length === 0 && <div className="popover-empty">No other projects yet.</div>}

          <div className="popover-sep" />

          <button
            className="popover-item"
            onClick={() => {
              setOpen(false)
              onAddProject()
            }}
          >
            <span className="pi-name">Add project&hellip;</span>
          </button>

          <button
            className="popover-item"
            onClick={() => {
              setOpen(false)
              if (guardUnsaved()) closeProject()
            }}
          >
            <span className="pi-name">Close project</span>
          </button>
        </div>
      )}
    </div>
  )
}
