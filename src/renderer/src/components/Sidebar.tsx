import { useState } from 'react'
import ContextMenu, { type MenuItem } from './ContextMenu'
import type { PassMode } from '@shared/api'
import type { LabelEndKind } from '@shared/types'
import { useStore } from '../state/store'
import { beatName } from '../beatName'
import ProjectSwitcher from './ProjectSwitcher'

const END_KIND_LABEL: Record<LabelEndKind, string> = {
  jump: '',
  fallthrough: 'falls through',
  'hand-authored': 'branches'
}

const END_KIND_COLOR: Record<LabelEndKind, string> = {
  jump: 'var(--text-faint)',
  fallthrough: 'var(--warn)',
  'hand-authored': 'var(--accent)'
}

interface Props {
  /** Extra classes from the shell, used to show or hide this as a pane. */
  className?: string
  /** Called when something was opened in the editor, so a phone can go there. */
  onOpenedInEditor?: () => void
  /** Ask for a translation or a proofread; a null beat means the whole episode. */
  onPass: (
    mode: PassMode,
    fileName: string,
    beat: { label: string; from: number; to: number } | null
  ) => void
  /** Open the render sync panel for an episode. */
  onSyncRenders: (episodeId: string) => void
  onNewEpisode: () => void
  onSettings: () => void
  onAddProject: () => void
  onRevealLine: (fileName: string, line: number) => void
}

/**
 * Episodes and their beats. A beat is a Ren'Py label; beats with no label are
 * outlined but not written yet.
 */
export default function Sidebar({
  className = '',
  onOpenedInEditor,
  onPass,
  onSyncRenders,
  onNewEpisode,
  onSettings,
  onAddProject,
  onRevealLine
}: Props) {
  // Selected one field at a time: an object selector would return a fresh
  // object every render and loop under zustand v5.
  const opened = useStore((s) => s.opened)
  const capabilities = useStore((s) => s.capabilities)
  const parsed = useStore((s) => s.parsed)
  const activeTab = useStore((s) => s.activeTab)
  const openEpisode = useStore((s) => s.openEpisode)
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  const [dragEpisode, setDragEpisode] = useState<string | null>(null)
  const [overEpisode, setOverEpisode] = useState<string | null>(null)
  const reorderEpisodes = useStore((s) => s.reorderEpisodes)
  const setEpisodeStatus = useStore((s) => s.setEpisodeStatus)
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null)

  if (!opened) return null
  const beats = opened.beats
  const { project, episodes, unregisteredFiles } = opened

  return (
    <aside className={'sidebar' + className}>
      <div className="sidebar-head">
        <div style={{ minWidth: 0 }}>
          <ProjectSwitcher onAddProject={onAddProject} />
          <div className="sub">
            {project.settings.linear ? 'Linear' : 'Non-linear'} &middot;{' '}
            {project.settings.sourceLanguage} &rarr; {project.settings.targetLanguage}
          </div>
        </div>
        <div style={{ display: 'flex', flex: 'none' }}>
          <button className="ghost" title="Project settings" onClick={onSettings}>
            &#9881;
          </button>
        </div>
      </div>

      <div className="outline">
        {episodes.length === 0 && (
          <div className="empty-note">
            No episodes yet. Add one to create a new .rpy file, or import a script that already
            exists in the game folder.
          </div>
        )}

        {episodes.map((ep) => {
          const epBeats = beats
            .filter((b) => b.episodeId === ep.id)
            .sort((a, b) => a.order - b.order)
          const spans = parsed[ep.fileName]?.labels ?? []
          const isCollapsed = collapsed[ep.id] ?? false

          return (
            <div key={ep.id}>
              <div
                className={
                  'episode-row' +
                  (activeTab === ep.fileName ? ' active' : '') +
                  (overEpisode === ep.id ? ' dragover' : '') +
                  (dragEpisode === ep.id ? ' dragging' : '')
                }
                onDragOver={(e) => {
                  if (!dragEpisode || dragEpisode === ep.id) return
                  e.preventDefault()
                  setOverEpisode(ep.id)
                }}
                onDragLeave={() => setOverEpisode((d) => (d === ep.id ? null : d))}
                onDrop={(e) => {
                  if (!dragEpisode || dragEpisode === ep.id) return
                  e.preventDefault()
                  const ids = episodes.map((x) => x.id)
                  const from = ids.indexOf(dragEpisode)
                  const to = ids.indexOf(ep.id)
                  ids.splice(to, 0, ...ids.splice(from, 1))
                  void reorderEpisodes(ids)
                  setDragEpisode(null)
                  setOverEpisode(null)
                }}
                onContextMenu={(e) => {
                  e.preventDefault()
                  const isDraft = (ep.status ?? 'release') === 'draft'
                  setMenu({
                    x: e.clientX,
                    y: e.clientY,
                    items: [
                      ...(capabilities.languagePasses
                        ? [
                            {
                              label: `Translate ${ep.name}`,
                              onSelect: () => onPass('translate', ep.fileName, null)
                            },
                            {
                              label: `Proofread ${ep.name}`,
                              onSelect: () => onPass('proofread', ep.fileName, null)
                            }
                          ]
                        : []),
                      // Left out where it cannot work rather than offered and
                      // then explained: a browser has no Blender folder and no
                      // encoder, so there is nothing for this to do there.
                      ...(capabilities.renderSync
                        ? [
                            {
                              label: ep.renders?.sourceDir
                                ? `Sync renders for ${ep.name}\u2026`
                                : 'Set up renders\u2026',
                              separated: true,
                              onSelect: () => onSyncRenders(ep.id)
                            }
                          ]
                        : []),
                      {
                        label: isDraft ? 'Move back into the game' : 'Make it a draft',
                        separated: true,
                        onSelect: () =>
                          void setEpisodeStatus(ep.id, isDraft ? 'release' : 'draft')
                      }
                    ]
                  })
                }}
                onClick={() => {
                  // Clicking the episode both opens it and folds its beats,
                  // so the name behaves like the caret next to it.
                  setCollapsed((c) => ({ ...c, [ep.id]: !c[ep.id] }))
                  void openEpisode(ep.fileName)
                  onOpenedInEditor?.()
                }}
              >
                <span
                  className="rl-grip"
                  title="Drag to reorder episodes"
                  draggable
                  onClick={(e) => e.stopPropagation()}
                  onDragStart={(e) => {
                    e.stopPropagation()
                    e.dataTransfer.effectAllowed = 'move'
                    setDragEpisode(ep.id)
                  }}
                  onDragEnd={() => {
                    setDragEpisode(null)
                    setOverEpisode(null)
                  }}
                >
                  &#9776;
                </span>
                <span
                  className={'ep-caret' + (isCollapsed ? ' collapsed' : '')}
                  title={isCollapsed ? 'Show beats' : 'Hide beats'}
                  onClick={(e) => {
                    e.stopPropagation()
                    setCollapsed((c) => ({ ...c, [ep.id]: !c[ep.id] }))
                  }}
                >
                  &#9662;
                </span>
                <span>{ep.name}</span>
                {(ep.status ?? 'release') === 'draft' && (
                  <span className="ep-draft" title="Draft: not in the game folder">
                    draft
                  </span>
                )}
                {isCollapsed && epBeats.length > 0 && (
                  <span className="ep-count">{epBeats.length}</span>
                )}
                <span className="file">{ep.fileName}</span>
              </div>

              {!isCollapsed && epBeats.map((beat) => {
                const span = beat.label ? spans.find((s) => s.label === beat.label) : undefined
                const kind = span?.endKind
                return (
                  <div
                    key={beat.id}
                    className={'beat-row' + (beat.label ? '' : ' unwritten')}
                    title={beat.label ?? 'Not written yet'}
                    onContextMenu={(e) => {
                      e.preventDefault()
                      setMenu({
                        x: e.clientX,
                        y: e.clientY,
                        items: [
                          ...(capabilities.languagePasses ? [
                          {
                            label: `Translate ${beat.title}`,
                            disabled: !span,
                            onSelect: () =>
                              span &&
                              onPass('translate', ep.fileName, {
                                label: span.label,
                                from: span.startLine,
                                to: span.endLine
                              })
                          },
                          {
                            label: `Proofread ${beat.title}`,
                            disabled: !span,
                            onSelect: () =>
                              span &&
                              onPass('proofread', ep.fileName, {
                                label: span.label,
                                from: span.startLine,
                                to: span.endLine
                              })
                          },
                          {
                            label: `Translate ${ep.name}`,
                            separated: true,
                            onSelect: () => onPass('translate', ep.fileName, null)
                          },
                          {
                            label: `Proofread ${ep.name}`,
                            onSelect: () => onPass('proofread', ep.fileName, null)
                          }
                          ] : []),
                        ]
                      })
                    }}
                    onClick={() => {
                      if (span) onRevealLine(ep.fileName, span.startLine)
                      else void openEpisode(ep.fileName)
                      onOpenedInEditor?.()
                    }}
                  >
                    <span
                      className="dot"
                      style={{
                        background: kind ? END_KIND_COLOR[kind] : 'transparent',
                        border: kind ? 'none' : '1px solid var(--text-faint)'
                      }}
                    />
                    <span className="title">{beatName(beat.title)}</span>
                    {kind && END_KIND_LABEL[kind] && (
                      <span className="kind">{END_KIND_LABEL[kind]}</span>
                    )}
                  </div>
                )
              })}
            </div>
          )
        })}

        {unregisteredFiles.length > 0 && (
          <div className="empty-note">
            {unregisteredFiles.length} script file{unregisteredFiles.length === 1 ? '' : 's'} in the
            game folder {unregisteredFiles.length === 1 ? 'is' : 'are'} not an episode yet. Use Add
            episode &rarr; Import to adopt {unregisteredFiles.length === 1 ? 'it' : 'them'}.
          </div>
        )}
      </div>

      <div style={{ padding: 10, borderTop: '1px solid var(--border)' }}>
        <button style={{ width: '100%' }} onClick={onNewEpisode}>
          Add episode
        </button>
      </div>
      {menu && (
        <ContextMenu at={menu} items={menu.items} onClose={() => setMenu(null)} />
      )}
    </aside>
  )
}
