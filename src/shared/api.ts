import type { ScriptNode } from './renpy/document'
import type {
  Beat,
  DiscoveredCharacter,
  EpisodeStatus,
  Reference,
  Episode,
  ParsedEpisode,
  Project,
  ProjectRef,
  ProjectSettings,
  RenderConfig,
  RenpyRootCheck
} from './types'

export interface OpenedProject {
  project: Project
  episodes: Episode[]
  beats: Beat[]
  /** .rpy files in the script folder that are not registered as episodes yet. */
  unregisteredFiles: string[]
  /**
   * Parse result per episode file, so the outline can show where each beat
   * leads without the file having been opened.
   */
  parsedEpisodes: Record<string, ParsedEpisode>
}

/**
 * The known projects, plus whether the list could be trusted. An empty list
 * with no error is a new install; an empty list with an error is a problem,
 * and the difference must reach the screen.
 */
export interface ProjectListing {
  projects: ProjectRef[]
  error?: string
  /** Where the list is stored, so a message can point at it. */
  path: string
  /** The list came from the backup because the main file was unusable. */
  recovered?: boolean
}

export interface CreateProjectInput {
  name: string
  renpyRoot: string
  settings: ProjectSettings
}

export interface CreateEpisodeInput {
  renpyRoot: string
  /** 'new' scaffolds an empty file; 'import' adopts an existing one. */
  mode: 'new' | 'import'
  /** Display name, e.g. "Episode 1". Derived from the file name when importing. */
  name: string
  /** Required for 'import': the existing file to adopt. */
  fileName?: string
  /** Defaults to 'release'. A draft is kept out of the game folder entirely. */
  status?: EpisodeStatus
}

/** Translating into the target language, or correcting text already in it. */
export type PassMode = 'translate' | 'proofread'

export interface ScriptPassRequest {
  fileName: string
  mode: PassMode
  /** 1-indexed source lines to limit to; empty or absent means the whole file. */
  lines?: number[]
}

export interface LineChange {
  line: number
  speaker: string | null
  before: string
  after: string
}

export interface ScriptPassOutcome {
  changes: LineChange[]
  /**
   * Lines the pass deliberately left alone: already in the target language
   * when translating, still in the source language when proofreading.
   */
  skipped: number
  /** File content before the run, so it can be put back. */
  previous: string
  error?: string
}

/** One still in an episode's render folder, and whether it needs work. */
export interface RenderItem {
  name: string
  outputName: string
  status: 'new' | 'stale' | 'current'
  sourceBytes: number
  sourceModified: number
  targetBytes?: number
  targetModified?: number
}

export interface RenderPlan {
  sourceDir: string
  targetDir: string
  items: RenderItem[]
  /** Sub-folders deliberately not looked at, named so the skip is visible. */
  ignoredDirs: string[]
  ignoredFiles: number
  error?: string
}

export interface ConvertedItem {
  name: string
  outputName: string
  ok: boolean
  bytes?: number
  error?: string
  /** Where it landed, relative to the project root, for the sync to save. */
  repoPath?: string
}

/** A working ffmpeg found somewhere on the machine. */
export interface FfmpegCandidate {
  command: string
  version: string
  label: string
}

export interface FfmpegStatus {
  ok: boolean
  command?: string
  version?: string
  candidates: FfmpegCandidate[]
  error?: string
}

export type GitChangeState =
  | 'modified'
  | 'added'
  | 'deleted'
  | 'renamed'
  | 'untracked'
  | 'conflicted'

export type GitChangeGroup = 'script' | 'reference' | 'image' | 'audio' | 'other'

export interface GitChange {
  path: string
  state: GitChangeState
  group: GitChangeGroup
}

export interface GitStatus {
  isRepo: boolean
  branch: string | null
  upstream: string | null
  ahead: number
  behind: number
  changes: GitChange[]
  conflicted: string[]
  identity: { name?: string; email?: string }
  /** A remote branch that already holds this work: it is up for review. */
  awaitingReview: string | null
  error?: string
}

/** Somewhere worth going after a push: the merge request, or the page to open one. */
export interface GitLink {
  url: string
  label: string
  /** True when the merge request exists. False when this only offers to open one. */
  exists: boolean
}

/** Which side of a disagreement to keep, or a third answer written on the spot. */
export type Take = 'mine' | 'theirs' | 'custom'

export interface ConflictSide {
  /** The lines exactly as they are, which is what gets written back. */
  lines: string[]
  /** The same lines parsed, so a speaker can be shown instead of syntax. */
  nodes: ScriptNode[]
}

export interface ConflictRegion {
  index: number
  file: string
  line: number
  mine: ConflictSide
  theirs: ConflictSide
  base: ConflictSide
}

export interface FileConflict {
  file: string
  regions: ConflictRegion[]
}

export interface Decision {
  file: string
  index: number
  take: Take
  text?: string
}

export interface GitResult {
  ok: boolean
  message: string
  detail?: string
  link?: GitLink
  /** Lines changed in the same place on both sides. Nothing was changed when present. */
  conflicts?: FileConflict[]
}

export interface CommitRequest {
  message: string
  paths: string[]
  push?: boolean
}

/**
 * What this installation can actually do.
 *
 * Some of the app needs things only a desktop has: a person at the keyboard to
 * choose a folder, a Blender output folder full of renders, an image encoder,
 * the images themselves. A server has none of those, and the browser and phone
 * talk to a server. Rather than offer those features and fail, the interface
 * asks what is supported and leaves out the rest.
 */
export interface HostCapabilities {
  /** Choosing a folder needs somebody standing at the machine. */
  folderPicker: boolean
  /** Converting renders needs a local source folder and an encoder. */
  renderSync: boolean
  /** Previewing artwork needs the image files, which a server does not keep. */
  imagePreviews: boolean
  /** Translating and proofreading shell out to a command line tool. */
  languagePasses: boolean
  /**
   * Whether projects can be added and removed from here.
   *
   * A desktop is somebody's own machine, so they choose. On a server the list
   * is the operator's: it says which folders on that machine are the app's
   * business, and nobody signing in gets to widen it.
   */
  manageProjects: boolean
}

export interface MoveBeatRequest {
  label: string
  fromEpisodeId: string
  toEpisodeId: string
  /** Position among the target file labels; -1 appends. */
  toIndex: number
}

export interface MoveBeatOutcome {
  opened: OpenedProject
  /** Jumps written to keep the story running the same way. */
  materialised: string[]
  /** Places the new order could not be applied automatically. */
  warnings: string[]
  error?: string
}

/** The surface the renderer sees. Mirrored by the preload bridge. */
export interface RenpyWriterApi {
  listProjects(): Promise<ProjectListing>
  pickFolder(): Promise<string | null>
  checkRoot(root: string): Promise<RenpyRootCheck>
  createProject(input: CreateProjectInput): Promise<OpenedProject>
  openProject(renpyRoot: string): Promise<OpenedProject>
  removeProject(id: string): Promise<ProjectRef[]>
  updateSettings(renpyRoot: string, settings: ProjectSettings): Promise<Project>

  scanCharacters(renpyRoot: string): Promise<DiscoveredCharacter[]>
  /** Portrait as a data URL, or null if missing. Path is relative to game/. */
  readPortrait(renpyRoot: string, relPath: string): Promise<string | null>
  /** Preview for a Ren'Py image name used by `scene` or `show`. */
  resolveImage(
    renpyRoot: string,
    name: string
  ): Promise<{
    dataUrl: string | null
    matched?: string
    kind?: 'image' | 'video' | 'color'
    color?: string
    reason?: string
  }>

  /**
   * Rewrite a character's display name in the script itself. Returns the cast
   * as it now reads, or an error when the define line no longer matches.
   */
  renameCharacter(
    renpyRoot: string,
    varName: string,
    newName: string
  ): Promise<{ ok: boolean; reason?: string; characters: DiscoveredCharacter[] }>

  readReference(renpyRoot: string): Promise<Reference>
  writeReference(renpyRoot: string, reference: Reference): Promise<void>

  createEpisode(input: CreateEpisodeInput): Promise<OpenedProject>
  reorderEpisodes(renpyRoot: string, ids: string[]): Promise<OpenedProject>
  setEpisodeStatus(
    renpyRoot: string,
    episodeId: string,
    status: EpisodeStatus
  ): Promise<OpenedProject>
  moveBeat(renpyRoot: string, input: MoveBeatRequest): Promise<MoveBeatOutcome>
  runScriptPass(renpyRoot: string, input: ScriptPassRequest): Promise<ScriptPassOutcome>

  /** Point an episode at a render folder. */
  setEpisodeRenders(
    renpyRoot: string,
    episodeId: string,
    renders: RenderConfig | null
  ): Promise<OpenedProject>
  /**
   * Add a beat to an episode's outline, with no label in the script yet.
   *
   * Planning runs ahead of writing: a beat can exist as a card long before
   * anything is written for it, and nothing is added to the .rpy until
   * somebody writes it.
   */
  createBeat(renpyRoot: string, episodeId: string, title: string): Promise<OpenedProject>
  /** Change a beat's title or the note kept with it. */
  updateBeat(
    renpyRoot: string,
    beatId: string,
    changes: { title?: string; description?: string }
  ): Promise<OpenedProject>
  /**
   * Forget a beat that was never written.
   *
   * A beat with a label is refused: the label is in the script, and removing
   * a card is not a reason to delete somebody's scene.
   */
  removeBeat(renpyRoot: string, beatId: string): Promise<OpenedProject>

  /** What this installation supports. Asked once, before anything is drawn. */
  capabilities(): Promise<HostCapabilities>

  /** What has changed since the last commit, and how the branch stands. */
  gitStatus(renpyRoot: string): Promise<GitStatus>
  /** The same, after asking the remote what it has. Slower, and current. */
  gitFetchStatus(renpyRoot: string): Promise<GitStatus>
  /** Bring in other machines' work. Fast-forward only. */
  gitPull(renpyRoot: string): Promise<GitResult>
  /** Record the named paths, optionally sending them on. */
  gitCommit(renpyRoot: string, input: CommitRequest): Promise<GitResult>
  /** Send commits already recorded. */
  gitPush(renpyRoot: string): Promise<GitResult>
  /** Bring in changes once somebody has said which lines to keep. */
  gitResolvePull(renpyRoot: string, decisions: Decision[]): Promise<GitResult>

  /** Whether renders can be converted at all, and what else could do it. */
  checkFfmpeg(renpyRoot: string): Promise<FfmpegStatus>
  /** What a render sync would copy, without copying anything. */
  planRenderSync(renpyRoot: string, episodeId: string): Promise<RenderPlan>
  /** Convert a batch of stills; the caller loops so progress can be shown. */
  convertRenders(
    renpyRoot: string,
    episodeId: string,
    names: string[]
  ): Promise<ConvertedItem[]>
  parseEpisode(renpyRoot: string, fileName: string): Promise<ParsedEpisode>
  readEpisode(renpyRoot: string, fileName: string): Promise<string>
  writeEpisode(renpyRoot: string, fileName: string, content: string): Promise<void>
}

export const IPC = {
  listProjects: 'projects:list',
  pickFolder: 'projects:pickFolder',
  checkRoot: 'projects:checkRoot',
  createProject: 'projects:create',
  openProject: 'projects:open',
  removeProject: 'projects:remove',
  updateSettings: 'projects:updateSettings',
  scanCharacters: 'project:characters',
  readPortrait: 'project:portrait',
  resolveImage: 'project:image',
  renameCharacter: 'project:renameCharacter',
  readReference: 'reference:read',
  writeReference: 'reference:write',
  createEpisode: 'episodes:create',
  reorderEpisodes: 'episodes:reorder',
  setEpisodeStatus: 'episodes:setStatus',
  moveBeat: 'beats:move',
  createBeat: 'beats:create',
  updateBeat: 'beats:update',
  removeBeat: 'beats:remove',
  runScriptPass: 'script:pass',
  capabilities: 'host:capabilities',
  gitStatus: 'git:status',
  gitFetchStatus: 'git:fetchStatus',
  gitPull: 'git:pull',
  gitCommit: 'git:commit',
  gitPush: 'git:push',
  gitResolvePull: 'git:resolvePull',
  setEpisodeRenders: 'renders:configure',
  checkFfmpeg: 'renders:checkEncoder',
  planRenderSync: 'renders:plan',
  convertRenders: 'renders:convert',
  parseEpisode: 'episodes:parse',
  readEpisode: 'episodes:read',
  writeEpisode: 'episodes:write'
} as const
