import { useEffect, useState } from 'react'
import { onApiChange } from '../api'
import { useStore } from '../state/store'
import AddProjectForm from './AddProjectForm'

/**
 * Shown until a project is open: the list of known projects, plus the flow for
 * pointing the app at a Ren'Py folder.
 */
export default function ProjectGate() {
  const { projects, refreshProjects, openProject, removeProject, createProject, error, loading } =
    useStore()
  const [adding, setAdding] = useState(false)

  const loadCapabilities = useStore((s) => s.loadCapabilities)
  const capabilities = useStore((s) => s.capabilities)
  const projectsPath = useStore((s) => s.projectsPath)

  useEffect(() => {
    const load = (): void => {
      void loadCapabilities()
      void refreshProjects()
    }
    load()
    // And again if the transport is replaced under us: a different host can
    // support a different set of things.
    return onApiChange(load)
  }, [refreshProjects, loadCapabilities])

  return (
    <div className="gate">
      <div className="gate-card">
        <h1>Ren&rsquo;Py Writer</h1>
        <p className="hint">
          Write in screenplay form, keep the .rpy file as the source of truth.
        </p>

        {projects.length > 0 && (
          <div className="project-list">
            {projects.map((p) => (
              <div key={p.id} className="project-item" onClick={() => void openProject(p.renpyRoot)}>
                <div className="meta">
                  <div className="name">{p.name}</div>
                  {capabilities.manageProjects && <div className="path">{p.renpyRoot}</div>}
                </div>
                <div className="actions">
                  <button
                    className="ghost"
                    title="Remove from this list (the folder is not touched)"
                    onClick={(e) => {
                      e.stopPropagation()
                      void removeProject(p.id)
                    }}
                  >
                    &times;
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Only ever say "none" when none is what was actually found. An
            unreadable list must not look like a fresh install, or the obvious
            next move -- adding the project again -- writes over the list that
            still holds the others. */}
        {projects.length === 0 && !adding && !error && (
          <>
            <p className="hint">
              {capabilities.manageProjects
                ? 'No projects yet. Point the app at a Ren’Py game folder.'
                : 'This server has no projects yet. They are chosen by whoever runs it, with the --project option.'}
            </p>
            {/* Where it looked. "No projects yet" is a claim nobody can check:
                it reads the same whether the list is genuinely empty or the
                app is reading a different file than the one being edited. The
                path turns that into something anyone can verify in a second. */}
            {capabilities.manageProjects && projectsPath && (
              <p className="hint faint gate-path" title={projectsPath}>
                Looked in {projectsPath}
              </p>
            )}
          </>
        )}

        {error && (
          <div className="error">
            {error}
            <button className="ghost retry" onClick={() => void refreshProjects()}>
              Try again
            </button>
          </div>
        )}

        {adding ? (
          <AddProjectForm
            busy={loading}
            onCancel={() => setAdding(false)}
            onCreate={async (input) => {
              await createProject(input)
              setAdding(false)
            }}
            onOpenExisting={async (root) => {
              await openProject(root)
              setAdding(false)
            }}
          />
        ) : (
          capabilities.manageProjects && (
            <div className="actions-row">
              <button className="primary" onClick={() => setAdding(true)}>
                Add project
              </button>
            </div>
          )
        )}
      </div>
    </div>
  )
}
