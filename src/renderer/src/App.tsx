import { useEffect, useRef, useState } from 'react'
import type { ImageLookup } from './imageHover'
import type { PassMode } from '@shared/api'
import { isDirty, isEpisodeTab, useStore } from './state/store'
import ProjectGate from './components/ProjectGate'
import Sidebar from './components/Sidebar'
import CodeView from './components/CodeView'
import NewEpisodeDialog from './components/NewEpisodeDialog'
import SettingsDialog from './components/SettingsDialog'
import AddProjectForm from './components/AddProjectForm'
import WriterView from './components/WriterView'
import ReferencePanel from './components/ReferencePanel'
import CharacterEditor from './components/CharacterEditor'
import PlotBoard from './components/PlotBoard'
import ScriptPassPanel from './components/ScriptPassPanel'
import RenderSyncPanel from './components/RenderSyncPanel'
import SyncPanel from './components/SyncPanel'
import PhoneNav, { type Pane } from './components/PhoneNav'
import RemoveBeatDialog, { type PendingRemoval } from './components/RemoveBeatDialog'
import { usePhoneLayout } from './usePhoneLayout'
import { api } from './api'

export default function App() {
  const opened = useStore((s) => s.opened)
  const tabs = useStore((s) => s.tabs)
  const activeTab = useStore((s) => s.activeTab)
  const mode = useStore((s) => s.mode)
  const parsed = useStore((s) => s.parsed)
  const setMode = useStore((s) => s.setMode)
  const setActiveTab = useStore((s) => s.setActiveTab)
  const closeTab = useStore((s) => s.closeTab)
  const updateTabContent = useStore((s) => s.updateTabContent)
  const saveActiveTab = useStore((s) => s.saveActiveTab)
  const openEpisode = useStore((s) => s.openEpisode)
  const characters = useStore((s) => s.characters)
  const saving = useStore((s) => s.saving)
  const saveError = useStore((s) => s.saveError)
  const anchorLines = useStore((s) => s.anchorLines)
  const capabilities = useStore((s) => s.capabilities)
  const setAnchorLine = useStore((s) => s.setAnchorLine)
  const flushPendingSaves = useStore((s) => s.flushPendingSaves)
  const planRemoveBeat = useStore((s) => s.planRemoveBeat)
  const error = useStore((s) => s.error)
  const dismissError = useStore((s) => s.dismissError)
  const reportError = useStore((s) => s.reportError)
  const refreshOpenTabs = useStore((s) => s.refreshOpenTabs)

  const [showNewEpisode, setShowNewEpisode] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [showAddProject, setShowAddProject] = useState(false)
  const [showReference, setShowReference] = useState(false)
  const [reveal, setReveal] = useState<{ file: string; line: number } | null>(null)
  const [focusRequest, setFocusRequest] = useState<{
    varName: string
    nonce: number
  } | null>(null)
  const phone = usePhoneLayout()
  const [pane, setPane] = useState<Pane>('script')
  const [showSync, setShowSync] = useState(false)
  const [removingBeat, setRemovingBeat] = useState<PendingRemoval | null>(null)
  const [renderEpisodeId, setRenderEpisodeId] = useState<string | null>(null)
  const [passRequest, setPassRequest] = useState<{
    mode: PassMode
    fileName: string
    beat: { label: string; from: number; to: number } | null
  } | null>(null)
  // Data URLs are costly to produce, so remember them for the session.
  const imageCache = useRef(new Map<string, ImageLookup | null>())

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault()
        void saveActiveTab()
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setShowReference((v) => !v)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [saveActiveTab])

  useEffect(() => {
    /**
     * A phone browser stops timers the moment it is backgrounded, and may throw
     * the page away without warning. Anything still waiting on the autosave
     * debounce would go with it, so it is written the instant the page is
     * hidden rather than 1.2 seconds after the last keystroke.
     */
    const onHidden = (): void => {
      if (document.visibilityState === 'hidden') void flushPendingSaves()
    }
    /**
     * And on the way back: another client may have changed a file while this
     * one was away. Tabs with unsaved edits are left alone -- losing what
     * somebody typed is worse than showing them something slightly stale.
     */
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') void refreshOpenTabs()
    }
    const onVisibility = (): void => {
      onHidden()
      onVisible()
    }

    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('pagehide', onHidden)
    window.addEventListener('focus', onVisible)
    return () => {
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('pagehide', onHidden)
      window.removeEventListener('focus', onVisible)
    }
  }, [flushPendingSaves, refreshOpenTabs])

  if (!opened) return <ProjectGate />

  const tab = tabs.find((t) => t.key === activeTab) ?? null
  // Read fresh from the project each render, so saving a render folder is
  // reflected in the open panel rather than in a stale copy of the episode.
  const renderEpisode = opened.episodes.find((e) => e.id === renderEpisodeId) ?? null
  const episode = tab && isEpisodeTab(tab) ? tab : null
  const activeParsed = episode ? parsed[episode.fileName] : undefined

  async function lookupImage(name: string): Promise<ImageLookup | null> {
    const cache = imageCache.current
    if (cache.has(name)) return cache.get(name) ?? null
    const result = await api.resolveImage(opened!.project.renpyRoot, name)
    cache.set(name, result)
    return result
  }

  /**
   * Every label the rest of the project is using, so a scene named in the
   * writer cannot collide with one in another episode. Ren'Py labels are
   * global; the file on screen is not the whole story.
   */
  const episodeId = episode
    ? (opened.episodes.find((e) => e.fileName === episode.fileName)?.id ?? null)
    : null
  const labelsElsewhere = opened.beats
    .filter((b) => b.label && b.episodeId !== episodeId)
    .map((b) => b.label as string)

  /**
   * Removing a scene from the writer.
   *
   * Anything typed and not yet saved goes to disk first: the cut is made
   * against the file, and a beat removed from a version of it that is a second
   * old would take the last sentence with it.
   */
  async function requestRemoveBeat(label: string): Promise<void> {
    const beat = opened!.beats.find((b) => b.label === label)
    if (!beat) return
    await flushPendingSaves()
    const plan = await planRemoveBeat(beat.id)
    // A plan that could not be made is not a reason to do nothing quietly.
    if (!plan) return
    if (plan.error) {
      reportError(plan.error)
      return
    }
    setRemovingBeat({ id: beat.id, title: beat.title, plan })
  }

  /** Ctrl+click on a character cue opens them in the reference panel. */
  function revealCharacter(varName: string): void {
    setShowReference(true)
    if (phone) setPane('notes')
    // A new nonce each time, so clicking the same cue twice still focuses.
    setFocusRequest({ varName, nonce: Date.now() })
  }

  async function revealLine(fileName: string, line: number) {
    await openEpisode(fileName)
    setReveal({ file: fileName, line })
  }

  /** Carry the reading position across so each view opens at the same place. */
  function switchMode(next: 'writer' | 'code') {
    if (next === mode) return
    if (activeTab) {
      const line = anchorLines[activeTab]
      // A new object each time, so an unchanged line still triggers the scroll.
      if (line) setReveal({ file: activeTab, line })
    }
    setMode(next)
  }

  /** On a phone, opening something in the editor means going to that pane. */
  const toEditor = (): void => {
    if (phone) setPane('script')
  }

  const paneClass = (id: Pane): string =>
    phone ? (pane === id ? ' pane-shown' : ' pane-hidden') : ''

  return (
    <div className={'app' + (phone ? ' phone' : '')}>
      <Sidebar
        className={paneClass('outline')}
        onOpenedInEditor={toEditor}
        onPass={async (mode, fileName, beat) => {
          await openEpisode(fileName)
          setPassRequest({ mode, fileName, beat })
        }}
        onSyncRenders={(episodeId) => setRenderEpisodeId(episodeId)}
        onNewEpisode={() => setShowNewEpisode(true)}
        onSettings={() => setShowSettings(true)}
        onAddProject={() => setShowAddProject(true)}
        onRevealLine={(f, l) => void revealLine(f, l)}
      />

      <main className={'main' + paneClass('script')}>
        <div className="tabbar">
          {tabs.map((t) => (
            <div
              key={t.key}
              className={'tab' + (t.key === activeTab ? ' active' : '')}
              onClick={() => setActiveTab(t.key)}
            >
              {isDirty(t) && <span className="dirty" title="Unsaved changes" />}
              {t.kind !== 'episode' && <span className="tab-kind">{t.kind}</span>}
              <span>{isEpisodeTab(t) ? t.fileName : t.title}</span>
              <span
                className="close"
                onClick={(e) => {
                  e.stopPropagation()
                  closeTab(t.key)
                }}
              >
                &times;
              </span>
            </div>
          ))}

          <div className="mode-switch">
            <button
              className={'ref-toggle' + (activeTab === 'outline' ? ' on' : '')}
              title="Plot board: every episode and its beats"
              onClick={() => useStore.getState().openOutlineTab()}
            >
              Plot
            </button>
            <button
              className="ref-toggle"
              title="Save your work where your other machines can see it"
              onClick={() => setShowSync(true)}
            >
              Sync
            </button>
            <button
              className={'ref-toggle' + (showReference ? ' on' : '')}
              title="Characters, locations and notes (Ctrl+K)"
              onClick={() => setShowReference((v) => !v)}
            >
              Reference
            </button>
            <div className="seg" style={episode ? undefined : { display: 'none' }}>
              <button
                className={mode === 'writer' ? 'on' : ''}
                onClick={() => switchMode('writer')}
                title="Screenplay view"
              >
                Writer
              </button>
              <button
                className={mode === 'code' ? 'on' : ''}
                onClick={() => switchMode('code')}
                title="Ren'Py source"
              >
                Code
              </button>
            </div>
          </div>
        </div>

        <div className="editor-area">
          {!tab ? (
            <div className="placeholder">
              <h2>Nothing open</h2>
              <p>Pick an episode from the outline, or add one to get started.</p>
            </div>
          ) : tab.kind === 'outline' ? (
            <PlotBoard />
          ) : tab.kind === 'character' ? (
            <CharacterEditor characterKey={tab.characterKey} />
          ) : !episode ? null : mode === 'code' ? (
            <CodeView
              docKey={tab.fileName}
              value={tab.content}
              onChange={(v) => updateTabContent(tab.fileName, v)}
              onSave={() => void saveActiveTab()}
              revealLine={reveal?.file === tab.fileName ? reveal.line : null}
              onAnchorLine={(line) => setAnchorLine(tab.fileName, line)}
              onLookupImage={capabilities.imagePreviews ? lookupImage : undefined}
            />
          ) : (
            <WriterView
              docKey={tab.fileName}
              value={tab.content}
              onChange={(v) => updateTabContent(tab.fileName, v)}
              characters={characters}
              expressionsEnabled={
                opened.project.settings.expressionsEnabled && capabilities.imagePreviews
              }
              revealLine={reveal?.file === tab.fileName ? reveal.line : null}
              renpyRoot={opened.project.renpyRoot}
              onAnchorLine={(line) => setAnchorLine(tab.fileName, line)}
              onRevealCharacter={revealCharacter}
              onBeatPass={
                capabilities.languagePasses
                  ? (mode, beat) => setPassRequest({ mode, fileName: tab.fileName, beat })
                  : undefined
              }
              otherLabels={labelsElsewhere}
              onRemoveBeat={(label) => void requestRemoveBeat(label)}
            />
          )}
        </div>

        <div className="statusbar">
          {episode ? (
            <>
              <span>{episode.fileName}</span>
              <span>
                {activeParsed?.labels.length ?? 0} beats &middot; {activeParsed?.lineCount ?? 0}{' '}
                lines
              </span>
              {activeParsed?.hadBom && <span title="Byte order mark preserved on save">BOM</span>}
              {anchorLines[episode.fileName] && <span>Ln {anchorLines[episode.fileName]}</span>}
              <span className="spacer" />
              {saveError ? (
                <span style={{ color: 'var(--danger)' }}>Save failed: {saveError}</span>
              ) : saving === episode.fileName ? (
                <span>Saving…</span>
              ) : isDirty(episode) ? (
                <span>Unsaved — autosaves shortly</span>
              ) : (
                <span>Saved</span>
              )}
            </>
          ) : (
            <>
              {/*
                A folder path is worth showing on the machine that holds the
                folder. Over the web it names a directory on the server, which
                the reader cannot open, did not choose, and has no business
                being shown.
              */}
              <span>
                {capabilities.manageProjects ? opened.project.renpyRoot : opened.project.name}
              </span>
              <span className="spacer" />
              <span>
                {opened.episodes.length} episode{opened.episodes.length === 1 ? '' : 's'}
              </span>
            </>
          )}
        </div>
      </main>

      {passRequest && (
        <ScriptPassPanel
          mode={passRequest.mode}
          fileName={passRequest.fileName}
          beat={passRequest.beat}
          onClose={() => setPassRequest(null)}
        />
      )}

      {(showReference || phone) && (
        <ReferencePanel
          className={paneClass('notes')}
          hideClose={phone}
          onOpenedInEditor={toEditor}
          onClose={() => setShowReference(false)}
          focusRequest={focusRequest}
        />
      )}

      {phone && (
        <PhoneNav
          pane={pane}
          onPane={setPane}
          onSync={() => setShowSync(true)}
          pending={tabs.some((t) => isDirty(t))}
        />
      )}

      {showSync && <SyncPanel onClose={() => setShowSync(false)} />}

      {renderEpisode && (
        <RenderSyncPanel episode={renderEpisode} onClose={() => setRenderEpisodeId(null)} />
      )}

      {/*
        * Anything that refused to happen, and why.
        *
        * Every action here reports its refusal to the store, and for a long
        * while nothing displayed it: a beat that could not be removed simply
        * did not move, and the only way to find out why was to read the
        * source. An action that does nothing has to say so.
        */}
      {error && (
        <div className="app-error" role="alert">
          <span className="ae-text">{error}</span>
          <button className="ae-dismiss" onClick={dismissError} title="Dismiss">
            &times;
          </button>
        </div>
      )}

      {removingBeat && (
        <RemoveBeatDialog removing={removingBeat} onClose={() => setRemovingBeat(null)} />
      )}
      {showNewEpisode && <NewEpisodeDialog onClose={() => setShowNewEpisode(false)} />}
      {showSettings && <SettingsDialog onClose={() => setShowSettings(false)} />}
      {showAddProject && (
        <div className="modal-backdrop" onClick={() => setShowAddProject(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>Add project</h2>
            <AddProjectForm
              busy={false}
              onCancel={() => setShowAddProject(false)}
              onCreate={async (input) => {
                await useStore.getState().createProject(input)
                setShowAddProject(false)
              }}
              onOpenExisting={async (root) => {
                await useStore.getState().openProject(root)
                setShowAddProject(false)
              }}
            />
          </div>
        </div>
      )}
    </div>
  )
}
