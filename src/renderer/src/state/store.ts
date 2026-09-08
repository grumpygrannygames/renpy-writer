import { create } from 'zustand'
import { shouldWriteReference } from './referenceSave'
import type {
  CreateEpisodeInput,
  CreateProjectInput,
  OpenedProject,
  HostCapabilities,
  RemoveBeatPlan,
  LineChange,
  PassMode
} from '@shared/api'
import type {
  CharacterNote,
  EpisodeStatus,
  DiscoveredCharacter,
  FreeNote,
  LocationNote,
  Reference,
  ParsedEpisode,
  ProjectRef,
  ProjectSettings,
  RenderConfig
} from '@shared/types'
import { api } from '../api'

export type EditorMode = 'writer' | 'code'

/** Idle time before an edited tab is written back to disk. */
const AUTOSAVE_MS = 1200

/** Pending autosave timers, keyed by file name. */
const saveTimers = new Map<string, ReturnType<typeof setTimeout>>()

/** Reference material saves on the same debounce as script edits. */
let referenceTimer: ReturnType<typeof setTimeout> | null = null

export const EMPTY_REFERENCE: Reference = {
  characters: [],
  locations: [],
  notes: [],
  characterOrder: []
}

/** An episode script open for editing. */
export interface EpisodeTab {
  kind: 'episode'
  /** Tab identity; for an episode this is the file name. */
  key: string
  fileName: string
  content: string
  /** Content as last read from or written to disk, for dirty comparison. */
  savedContent: string
}

/** The plot board, showing every episode and its beats side by side. */
export interface OutlineTab {
  kind: 'outline'
  key: string
  title: string
}

/** A character opened full size, rather than in the side panel. */
export interface CharacterTab {
  kind: 'character'
  key: string
  /** Ren'Py variable, or the note id for someone not in script. */
  characterKey: string
  title: string
}

export type OpenTab = EpisodeTab | CharacterTab | OutlineTab

export const isEpisodeTab = (t: OpenTab): t is EpisodeTab => t.kind === 'episode'

interface AppState {
  projects: ProjectRef[]
  /** The file the project list was read from, so an empty one can say where it looked. */
  projectsPath: string | null
  opened: OpenedProject | null
  loading: boolean
  error: string | null

  tabs: OpenTab[]
  activeTab: string | null
  mode: EditorMode
  parsed: Record<string, ParsedEpisode>
  characters: DiscoveredCharacter[]
  /** File currently being written, for the status bar. */
  saving: string | null
  saveError: string | null
  /**
   * The line at the middle of the viewport per file, so Writer and Code open
   * at the same place in the script rather than at the same caret.
   */
  anchorLines: Record<string, number>

  reference: Reference
  /**
   * Which project the reference in hand was read from, or null when it has
   * not been read yet.
   *
   * The saves are debounced, so a write can land more than a second after the
   * edit that caused it -- by which time the open project may have changed,
   * or may not have finished loading. Without knowing where this data came
   * from, such a write puts one project's notes into another, or writes an
   * empty reference over a real one.
   */
  referenceFor: string | null

  /**
   * What this installation can do. Everything is assumed available until the
   * host has answered, so the desktop never flickers; a browser learns within
   * a moment that renders and previews are not its to offer.
   */
  capabilities: HostCapabilities
  loadCapabilities: () => Promise<void>
  refreshProjects: () => Promise<void>
  createProject: (input: CreateProjectInput) => Promise<void>
  openProject: (root: string) => Promise<void>
  closeProject: () => void
  removeProject: (id: string) => Promise<void>
  saveSettings: (settings: ProjectSettings) => Promise<void>

  createEpisode: (input: Omit<CreateEpisodeInput, 'renpyRoot'>) => Promise<void>
  openEpisode: (fileName: string) => Promise<void>
  openCharacterTab: (characterKey: string, title: string) => void
  openOutlineTab: () => void
  reorderEpisodes: (ids: string[]) => Promise<void>
  setEpisodeStatus: (episodeId: string, status: EpisodeStatus) => Promise<void>
  setEpisodeRenders: (episodeId: string, renders: RenderConfig | null) => Promise<void>
  createBeat: (episodeId: string, title: string) => Promise<void>
  updateBeat: (beatId: string, changes: { title?: string; description?: string }) => Promise<void>
  removeBeat: (beatId: string) => Promise<void>
  planRemoveBeat: (beatId: string) => Promise<RemoveBeatPlan | null>
  moveBeat: (input: {
    label: string
    fromEpisodeId: string
    toEpisodeId: string
    toIndex: number
  }) => Promise<void>
  /** Result of the last restructure, for a transient note in the UI. */
  lastMove: { materialised: string[]; warnings: string[]; error?: string } | null
  clearLastMove: () => void
  /** Re-read a file from disk into its open tab. */
  reloadTab: (fileName: string) => Promise<void>

  /** The translation or proofreading pass in flight, or its last result. */
  pass: {
    mode: PassMode
    running: boolean
    fileName: string | null
    changes: LineChange[]
    skipped: number
    previous: string | null
    error?: string
  } | null
  runScriptPass: (mode: PassMode, fileName: string, lines?: number[]) => Promise<void>
  revertPass: () => Promise<void>
  clearPass: () => void
  closeTab: (key: string) => void
  setActiveTab: (key: string) => void
  setMode: (mode: EditorMode) => void
  setAnchorLine: (fileName: string, line: number) => void

  upsertCharacterNote: (note: CharacterNote) => void
  renameScriptCharacter: (varName: string, newName: string) => Promise<string | null>
  /** Write a Character() definition for somebody the script does not have. */
  defineScriptCharacter: (name: string) => Promise<{ varName?: string; error?: string }>
  upsertLocation: (location: LocationNote) => void
  upsertNote: (note: FreeNote) => void
  removeReferenceItem: (kind: 'characters' | 'locations' | 'notes', id: string) => void
  setCharacterOrder: (ids: string[]) => void
  flushReference: () => Promise<void>

  updateTabContent: (fileName: string, content: string) => void
  saveTab: (fileName: string) => Promise<void>
  saveActiveTab: () => Promise<void>
  /**
   * Write everything waiting on a timer, now.
   *
   * Edits live only in memory until a debounce elapses. A phone browser stops
   * timers the moment it is backgrounded and may discard the page entirely, so
   * without this the last thing typed before switching apps is simply lost.
   */
  flushPendingSaves: () => Promise<void>
  /**
   * Re-read open files that changed underneath us, leaving unsaved ones alone.
   * Returns which were refreshed and which were skipped because of local edits.
   */
  refreshOpenTabs: () => Promise<{ refreshed: string[]; keptDirty: string[] }>
}

function message(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e)
  // Electron prefixes IPC rejections with the handler location; strip it.
  return raw.replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, '')
}

export const useStore = create<AppState>((set, get) => ({
  projects: [],
  projectsPath: null,
  opened: null,
  loading: false,
  error: null,

  tabs: [],
  activeTab: null,
  mode: 'code',
  parsed: {},
  characters: [],
  saving: null,
  saveError: null,
  anchorLines: {},
  reference: EMPTY_REFERENCE,
  referenceFor: null,
  lastMove: null,
  pass: null,

  capabilities: {
    folderPicker: true,
    renderSync: true,
    imagePreviews: true,
    languagePasses: true,
    manageProjects: true
  },

  loadCapabilities: async () => {
    try {
      const answer = await api.capabilities()
      // Only a well-formed answer replaces the defaults. A host that returns
      // nothing useful should leave the app working rather than take the
      // whole interface down on the first render that reads a flag.
      if (answer && typeof answer === 'object') {
        set((current) => ({ capabilities: { ...current.capabilities, ...answer } }))
      }
    } catch {
      // An installation too old to answer is a desktop, which can do it all.
    }
  },

  refreshProjects: async () => {
    try {
      const listing = await api.listProjects()
      set({
        projects: listing.projects,
        projectsPath: listing.path ?? null,
        // A read that failed must not look like a fresh install. Saying so
        // also stops someone re-adding a project on top of a list that is
        // only temporarily unreadable.
        error: listing.error
          ? listing.recovered
            ? `${listing.error} Recovered the list from the backup beside ${listing.path}.`
            : `${listing.error} Your projects are still on disk. Close the app and check ${listing.path} before adding anything.`
          : null
      })
    } catch (e) {
      // Surface it in the gate rather than letting it escape as an
      // unhandled rejection with nothing on screen to explain the empty list.
      set({ error: message(e) })
    }
  },

  createProject: async (input) => {
    set({ loading: true, error: null })
    try {
      const opened = await api.createProject(input)
      forgetReference()
      set({
        opened, tabs: [], activeTab: null, parsed: opened.parsedEpisodes,
        characters: [], reference: EMPTY_REFERENCE, referenceFor: null
      })
      const [cast, reference] = await Promise.all([
        api.scanCharacters(opened.project.renpyRoot),
        api.readReference(opened.project.renpyRoot)
      ])
      set({ characters: cast, reference, referenceFor: opened.project.renpyRoot })
      await get().refreshProjects()
    } catch (e) {
      set({ error: message(e) })
      throw e
    } finally {
      set({ loading: false })
    }
  },

  openProject: async (root) => {
    set({ loading: true, error: null })
    try {
      const opened = await api.openProject(root)
      forgetReference()
      set({
        opened, tabs: [], activeTab: null, parsed: opened.parsedEpisodes,
        characters: [], reference: EMPTY_REFERENCE, referenceFor: null
      })
      const [cast, reference] = await Promise.all([
        api.scanCharacters(root),
        api.readReference(root)
      ])
      set({ characters: cast, reference, referenceFor: root })
      await get().refreshProjects()
    } catch (e) {
      set({ error: message(e) })
    } finally {
      set({ loading: false })
    }
  },

  closeProject: () => {
    forgetReference()
    set({
      opened: null,
      tabs: [],
      activeTab: null,
      parsed: {},
      characters: [],
      reference: EMPTY_REFERENCE,
      referenceFor: null,
      error: null
    })
  },

  removeProject: async (id) => {
    set({ projects: await api.removeProject(id) })
  },

  saveSettings: async (settings) => {
    const opened = get().opened
    if (!opened) return
    await api.updateSettings(opened.project.renpyRoot, settings)
    await get().openProject(opened.project.renpyRoot)
  },

  createEpisode: async (input) => {
    const opened = get().opened
    if (!opened) return
    set({ error: null })
    const next = await api.createEpisode({
      ...input,
      renpyRoot: opened.project.renpyRoot
    })
    set({ opened: next, parsed: next.parsedEpisodes })
    await get().openEpisode(
      next.episodes[next.episodes.length - 1]?.fileName ?? input.fileName ?? ''
    )
  },

  openEpisode: async (fileName) => {
    const opened = get().opened
    if (!opened || !fileName) return

    if (get().tabs.some((t) => t.key === fileName)) {
      set({ activeTab: fileName })
      return
    }

    const root = opened.project.renpyRoot
    const [content, parsed] = await Promise.all([
      api.readEpisode(root, fileName),
      api.parseEpisode(root, fileName)
    ])

    set((s) => ({
      tabs: [...s.tabs, { kind: 'episode', key: fileName, fileName, content, savedContent: content }],
      activeTab: fileName,
      parsed: { ...s.parsed, [fileName]: parsed }
    }))
  },

  openCharacterTab: (characterKey, title) => {
    const key = `character:${characterKey}`
    set((s) =>
      s.tabs.some((t) => t.key === key)
        ? { activeTab: key }
        : {
            tabs: [...s.tabs, { kind: 'character', key, characterKey, title }],
            activeTab: key
          }
    )
  },

  openOutlineTab: () =>
    set((s) =>
      s.tabs.some((t) => t.key === 'outline')
        ? { activeTab: 'outline' }
        : {
            tabs: [...s.tabs, { kind: 'outline', key: 'outline', title: 'Plot' }],
            activeTab: 'outline'
          }
    ),

  reorderEpisodes: async (ids) => {
    const opened = get().opened
    if (!opened) return
    set({ opened: await api.reorderEpisodes(opened.project.renpyRoot, ids) })
  },

  setEpisodeRenders: async (episodeId, renders) => {
    const opened = get().opened
    if (!opened) return
    const next = await api.setEpisodeRenders(opened.project.renpyRoot, episodeId, renders)
    set({ opened: next, parsed: next.parsedEpisodes })
  },

  setEpisodeStatus: async (episodeId, status) => {
    const opened = get().opened
    if (!opened) return
    try {
      const next = await api.setEpisodeStatus(opened.project.renpyRoot, episodeId, status)
      set({ opened: next, parsed: next.parsedEpisodes })
    } catch (e) {
      set({ lastMove: { materialised: [], warnings: [], error: message(e) } })
    }
  },

  createBeat: async (episodeId, title) => {
    const opened = get().opened
    if (!opened) return
    try {
      const after = await api.createBeat(opened.project.renpyRoot, episodeId, title)
      set({ opened: after, parsed: after.parsedEpisodes })
      const file = after.episodes.find((e) => e.id === episodeId)?.fileName
      if (file) await reloadTabs(opened.project.renpyRoot, [file], get, set)
    } catch (e) {
      set({ error: message(e) })
    }
  },

  updateBeat: async (beatId, changes) => {
    const opened = get().opened
    if (!opened) return
    try {
      const after = await api.updateBeat(opened.project.renpyRoot, beatId, changes)
      set({ opened: after, parsed: after.parsedEpisodes })
    } catch (e) {
      set({ error: message(e) })
    }
  },

  planRemoveBeat: async (beatId) => {
    const opened = get().opened
    if (!opened) return null
    try {
      return await api.planRemoveBeat(opened.project.renpyRoot, beatId)
    } catch (e) {
      set({ error: message(e) })
      return null
    }
  },

  removeBeat: async (beatId) => {
    const opened = get().opened
    if (!opened) return
    // Which file it lived in, before it stops being in the outline.
    const episodeId = opened.beats.find((b) => b.id === beatId)?.episodeId
    const file = opened.episodes.find((e) => e.id === episodeId)?.fileName
    try {
      const after = await api.removeBeat(opened.project.renpyRoot, beatId)
      set({ opened: after, parsed: after.parsedEpisodes })
      if (file) await reloadTabs(opened.project.renpyRoot, [file], get, set)
    } catch (e) {
      // Refusing to remove a written beat is a message worth reading, not a
      // silent no-op that leaves somebody clicking the same button again.
      set({ error: message(e) })
    }
  },

  moveBeat: async (input) => {
    const opened = get().opened
    if (!opened) return
    try {
      const outcome = await api.moveBeat(opened.project.renpyRoot, input)
      set({
        opened: outcome.opened,
        parsed: outcome.opened.parsedEpisodes,
        lastMove: {
          materialised: outcome.materialised,
          warnings: outcome.warnings,
          error: outcome.error
        }
      })
      // Reload any open tab whose file the move rewrote.
      const root = opened.project.renpyRoot
      const touched = new Set(
        [input.fromEpisodeId, input.toEpisodeId]
          .map((id) => outcome.opened.episodes.find((e) => e.id === id)?.fileName)
          .filter(Boolean) as string[]
      )
      for (const fileName of touched) {
        if (!get().tabs.some((t) => t.key === fileName)) continue
        const content = await api.readEpisode(root, fileName)
        set((s) => ({
          tabs: s.tabs.map((t) =>
            isEpisodeTab(t) && t.fileName === fileName
              ? { ...t, content, savedContent: content }
              : t
          )
        }))
      }
    } catch (e) {
      set({ lastMove: { materialised: [], warnings: [], error: message(e) } })
    }
  },

  clearLastMove: () => set({ lastMove: null }),

  runScriptPass: async (mode, fileName, lines) => {
    const opened = get().opened
    if (!opened) return
    set({ pass: { mode, running: true, fileName, changes: [], skipped: 0, previous: null } })
    try {
      const outcome = await api.runScriptPass(opened.project.renpyRoot, {
        fileName,
        mode,
        lines
      })
      set({
        pass: {
          mode,
          running: false,
          fileName,
          changes: outcome.changes,
          skipped: outcome.skipped,
          previous: outcome.previous,
          error: outcome.error
        }
      })
      if (outcome.changes.length > 0) await get().reloadTab(fileName)
    } catch (e) {
      set({
        pass: {
          mode,
          running: false,
          fileName,
          changes: [],
          skipped: 0,
          previous: null,
          error: message(e)
        }
      })
    }
  },

  revertPass: async () => {
    const { opened, pass } = get()
    if (!opened || !pass?.previous || !pass.fileName) return
    await api.writeEpisode(opened.project.renpyRoot, pass.fileName, pass.previous)
    await get().reloadTab(pass.fileName)
    set({ pass: null })
  },

  clearPass: () => set({ pass: null }),

  reloadTab: async (fileName) => {
    const opened = get().opened
    if (!opened) return
    const root = opened.project.renpyRoot
    const [content, parsed] = await Promise.all([
      api.readEpisode(root, fileName),
      api.parseEpisode(root, fileName)
    ])
    set((s) => ({
      tabs: s.tabs.map((t) =>
        isEpisodeTab(t) && t.fileName === fileName
          ? { ...t, content, savedContent: content }
          : t
      ),
      parsed: { ...s.parsed, [fileName]: parsed }
    }))
  },

  closeTab: (key) => {
    const timer = saveTimers.get(key)
    if (timer) {
      clearTimeout(timer)
      saveTimers.delete(key)
      void get().saveTab(key)
    }
    set((s) => {
      const tabs = s.tabs.filter((t) => t.key !== key)
      const activeTab = s.activeTab === key ? (tabs[tabs.length - 1]?.key ?? null) : s.activeTab
      return { tabs, activeTab }
    })
  },

  setActiveTab: (key) => set({ activeTab: key }),
  setMode: (mode) => set({ mode }),

  setAnchorLine: (fileName, line) =>
    set((s) => (s.anchorLines[fileName] === line
      ? s
      : { anchorLines: { ...s.anchorLines, [fileName]: line } })),

  updateTabContent: (fileName, content) => {
    set((s) => ({
      tabs: s.tabs.map((t) =>
        isEpisodeTab(t) && t.fileName === fileName ? { ...t, content } : t
      )
    }))

    // Debounced autosave: the file is written once typing pauses.
    const existing = saveTimers.get(fileName)
    if (existing) clearTimeout(existing)
    saveTimers.set(
      fileName,
      setTimeout(() => {
        saveTimers.delete(fileName)
        void get().saveTab(fileName)
      }, AUTOSAVE_MS)
    )
  },

  renameScriptCharacter: async (varName, newName) => {
    const opened = get().opened
    if (!opened) return 'No project open.'
    const result = await api.renameCharacter(opened.project.renpyRoot, varName, newName)
    // The rescan is authoritative whether or not the write succeeded.
    set({ characters: result.characters })
    return result.ok ? null : (result.reason ?? 'Could not rename that character.')
  },

  defineScriptCharacter: async (name) => {
    const opened = get().opened
    if (!opened) return { error: 'No project open.' }
    const root = opened.project.renpyRoot
    const result = await api.defineCharacter(root, name)
    // The rescan is authoritative whether or not the write succeeded.
    set({ characters: result.characters })
    // Harmless unless that file happens to be open as an episode, in which
    // case its editor is now a version behind and would write the definition
    // straight back out again.
    await reloadTabs(root, ['characters.rpy'], get, set)
    if (!result.ok) return { error: result.reason ?? 'Could not write that definition.' }
    return { varName: result.varName }
  },

  upsertCharacterNote: (note) =>
    set((s) => {
      const characters = s.reference.characters.some((c) => c.id === note.id)
        ? s.reference.characters.map((c) => (c.id === note.id ? note : c))
        : [...s.reference.characters, note]
      scheduleReferenceSave(get)
      return { reference: { ...s.reference, characters } }
    }),

  upsertLocation: (location) =>
    set((s) => {
      const locations = s.reference.locations.some((l) => l.id === location.id)
        ? s.reference.locations.map((l) => (l.id === location.id ? location : l))
        : [...s.reference.locations, location]
      scheduleReferenceSave(get)
      return { reference: { ...s.reference, locations } }
    }),

  upsertNote: (note) =>
    set((s) => {
      const notes = s.reference.notes.some((n) => n.id === note.id)
        ? s.reference.notes.map((n) => (n.id === note.id ? note : n))
        : [...s.reference.notes, note]
      scheduleReferenceSave(get)
      return { reference: { ...s.reference, notes } }
    }),

  setCharacterOrder: (ids) =>
    set((s) => {
      scheduleReferenceSave(get)
      return { reference: { ...s.reference, characterOrder: ids } }
    }),

  removeReferenceItem: (kind, id) =>
    set((s) => {
      scheduleReferenceSave(get)
      return {
        reference: {
          ...s.reference,
          [kind]: (s.reference[kind] as Array<{ id: string }>).filter((x) => x.id !== id)
        } as Reference
      }
    }),

  flushReference: async () => {
    if (referenceTimer) {
      clearTimeout(referenceTimer)
      referenceTimer = null
    }
    const { opened, reference, referenceFor } = get()
    const root = opened?.project.renpyRoot ?? null
    if (!shouldWriteReference(root, root, referenceFor)) return
    await api.writeReference(root!, reference)
  },

  saveTab: async (fileName) => {
    const { opened, tabs } = get()
    const tab = tabs.find((t) => isEpisodeTab(t) && t.fileName === fileName)
    if (!opened || !tab || !isEpisodeTab(tab) || tab.content === tab.savedContent) return

    const root = opened.project.renpyRoot
    const written = tab.content
    set({ saving: fileName, saveError: null })
    try {
      await api.writeEpisode(root, fileName, written)
      const parsed = await api.parseEpisode(root, fileName)

      set((s) => ({
        tabs: s.tabs.map((t) =>
          // Compare against what we wrote: the user may have typed since.
          isEpisodeTab(t) && t.fileName === fileName ? { ...t, savedContent: written } : t
        ),
        parsed: { ...s.parsed, [fileName]: parsed }
      }))

      // Labels may have changed, so refresh the outline from the sidecar.
      const refreshed = await api.openProject(root)
      set({ opened: refreshed, parsed: { ...refreshed.parsedEpisodes, [fileName]: parsed } })
    } catch (e) {
      set({ saveError: message(e) })
    } finally {
      set({ saving: null })
    }
  },

  flushPendingSaves: async () => {
    const dirty = get()
      .tabs.filter((t) => isEpisodeTab(t) && t.content !== t.savedContent)
      .map((t) => (t as EpisodeTab).fileName)

    for (const fileName of dirty) {
      const timer = saveTimers.get(fileName)
      if (timer) {
        clearTimeout(timer)
        saveTimers.delete(fileName)
      }
    }

    await Promise.all([
      ...dirty.map((fileName) => get().saveTab(fileName)),
      get().flushReference()
    ])
  },

  refreshOpenTabs: async () => {
    const { opened, tabs } = get()
    const refreshed: string[] = []
    const keptDirty: string[] = []
    if (!opened) return { refreshed, keptDirty }

    for (const tab of tabs) {
      if (!isEpisodeTab(tab)) continue
      if (tab.content !== tab.savedContent) {
        // Somebody is mid-sentence here. Overwriting that to show a change
        // from elsewhere would be the worse of the two surprises.
        keptDirty.push(tab.fileName)
        continue
      }
      try {
        const onDisk = await api.readEpisode(opened.project.renpyRoot, tab.fileName)
        if (onDisk !== tab.savedContent) {
          await get().reloadTab(tab.fileName)
          refreshed.push(tab.fileName)
        }
      } catch {
        // A file that has gone away is not this function's problem to report.
      }
    }
    return { refreshed, keptDirty }
  },

  saveActiveTab: async () => {
    const { activeTab, tabs } = get()
    if (!activeTab) return
    const tab = tabs.find((t) => t.key === activeTab)
    // Character tabs autosave through the reference debounce.
    if (!tab || !isEpisodeTab(tab)) return void get().flushReference()
    const timer = saveTimers.get(activeTab)
    if (timer) {
      clearTimeout(timer)
      saveTimers.delete(activeTab)
    }
    await get().saveTab(activeTab)
  }
}))

/** Drop a write that has not happened yet, because it is about to be wrong. */
function forgetReference(): void {
  if (referenceTimer) clearTimeout(referenceTimer)
  referenceTimer = null
}

/**
/**
 * Bring open tabs back in line with files the app has just rewritten.
 *
 * Without this an editor keeps showing the text from before, and its autosave
 * writes that back a second later -- so a scene deleted from the plot board
 * reappears in the script, put there by the tab nobody had touched.
 */
async function reloadTabs(
  root: string,
  fileNames: string[],
  get: () => AppState,
  set: (fn: (s: AppState) => Partial<AppState>) => void
): Promise<void> {
  for (const fileName of new Set(fileNames)) {
    if (!get().tabs.some((t) => t.key === fileName)) continue
    const content = await api.readEpisode(root, fileName)
    set((s) => ({
      tabs: s.tabs.map((t) =>
        isEpisodeTab(t) && t.fileName === fileName
          ? { ...t, content, savedContent: content }
          : t
      )
    }))
  }
}

/**
 * Debounced write of the reference files, matching how script edits save.
 *
 * The check on the way out is the important part. This fires over a second
 * after the edit that scheduled it, and in that time the project can have
 * been closed and another opened -- so it writes only if what is in hand
 * still belongs to what is open. Without that, closing a project and opening
 * one wrote an empty reference over somebody's characters, and the app looked
 * like it had simply forgotten them.
 */
function scheduleReferenceSave(get: () => AppState): void {
  if (referenceTimer) clearTimeout(referenceTimer)
  const scheduledFor = get().opened?.project.renpyRoot ?? null
  referenceTimer = setTimeout(() => {
    referenceTimer = null
    const { opened, reference, referenceFor } = get()
    const root = opened?.project.renpyRoot ?? null
    if (!shouldWriteReference(scheduledFor, root, referenceFor)) return
    void api.writeReference(root!, reference)
  }, AUTOSAVE_MS)
}

export const isDirty = (t: OpenTab): boolean =>
  isEpisodeTab(t) && t.content !== t.savedContent
