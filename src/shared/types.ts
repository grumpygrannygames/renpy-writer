/**
 * Domain model shared by the Electron main process and the renderer.
 *
 * Guiding rule: the .rpy file holds everything that becomes the game.
 * The sidecar (.renpywriter/) holds everything about the writing process.
 */

export const SIDECAR_DIR = '.renpywriter'

// ---------------------------------------------------------------- projects

export interface ProjectSettings {
  /** Language the script is written in, e.g. 'cs'. */
  sourceLanguage: string
  /** Language the translate pass produces, e.g. 'en'. */
  targetLanguage: string
  /** Project uses `image side <char> <expr>` portraits. */
  expressionsEnabled: boolean
  /**
   * Linear projects keep each label's trailing jump pointed at the next beat.
   * Non-linear projects only get a jump added when one is missing; existing
   * jumps and conditional branches are never rewritten.
   */
  linear: boolean
  /** Where episode .rpy files live, relative to the game/ folder. '' means game/ itself. */
  scriptDir: string
  /** Command used for translation and proofreading. Defaults to 'claude'. */
  translateCommand?: string
  /**
   * Which encoder converts renders. 'builtin' uses the one inside Electron and
   * needs nothing installed; 'ffmpeg' shells out to a copy on this machine.
   * Defaults to 'builtin'. Machine-local, like ffmpegPath.
   */
  renderEncoder?: RenderEncoder
  /**
   * Command used when renderEncoder is 'ffmpeg'. Machine-local: one computer's
   * ffmpeg is not another's, so this never travels in the sidecar.
   */
  ffmpegPath?: string
  /**
   * libwebp quality for converted stills, 0-100. Defaults to 100, which is
   * what the existing artwork in a mature project usually measures at; a
   * conventional 85 would visibly degrade 3D renders with soft gradients.
   */
  renderQuality?: number
}

export type RenderEncoder = 'builtin' | 'ffmpeg'

export interface Project {
  id: string
  name: string
  /** Absolute path to the Ren'Py project root (the folder containing game/). */
  renpyRoot: string
  settings: ProjectSettings
  createdAt: string
  lastOpenedAt: string
}

/** The registry row kept in userData; the full project lives in its sidecar. */
export interface ProjectRef {
  id: string
  name: string
  renpyRoot: string
  lastOpenedAt: string
}

export const DEFAULT_SETTINGS: ProjectSettings = {
  sourceLanguage: 'cs',
  targetLanguage: 'en',
  expressionsEnabled: false,
  linear: true,
  scriptDir: 'scripts'
}

// ---------------------------------------------------------------- episodes

/**
 * Where an episode's file lives, which decides whether it ships.
 *
 * 'release' sits under game/ and is loaded by Ren'Py. 'draft' sits in the
 * sidecar, which Ren'Py never loads and the default build rules exclude from
 * distributions, so a plotted-but-unreleased episode cannot be found by
 * anyone poking around in the game files.
 */
export type EpisodeStatus = 'release' | 'draft'

/** An episode is one .rpy file, under game/<scriptDir>/ or in the drafts folder. */
export interface Episode {
  id: string
  /** Display name, e.g. "Episode 1". */
  name: string
  /** File name on disk, e.g. "episode_1.rpy". */
  fileName: string
  order: number
  /** Defaults to 'release' for projects written before drafts existed. */
  status?: EpisodeStatus
  /** Where this episode's renders come from, if it syncs any. */
  renders?: RenderConfig
}

/**
 * One episode's render folder.
 *
 * Renders are produced outside the project -- a Blender output folder -- so
 * the source is an absolute path on the machine doing the writing, while the
 * target stays inside the game so it travels with the repository.
 */
export interface RenderConfig {
  /**
   * Absolute path to the folder of rendered stills.
   *
   * Machine-local, and deliberately not stored in the shared sidecar: a path
   * to a Blender folder means nothing on anyone else's computer. It is kept
   * beside the project registry and folded back in when the project loads, so
   * it is empty on a machine that has no renders.
   */
  sourceDir?: string
  /** Folder under game/images to write into. '' writes to game/images itself. */
  targetSubdir: string
  /**
   * Look inside sub-folders as well. Off by default: a render folder usually
   * has an `old` or `Animations` beside the frames that are actually current,
   * and pulling those into the game is rarely what is wanted.
   */
  includeSubfolders?: boolean
}

/** Draft episodes live here, below the project root. */
export const DRAFTS_DIR = `${SIDECAR_DIR}/drafts`

// ------------------------------------------------------------------- beats

/**
 * A beat is a Ren'Py label. `label` is null for a beat that exists in the
 * outline but has not been written yet -- the outline-only case.
 */
export interface Beat {
  id: string
  episodeId: string
  /** The Ren'Py label name, or null if unwritten. Stable anchor for metadata. */
  label: string | null
  title: string
  description?: string
  order: number
}

/**
 * How a label hands control to whatever runs next.
 *  - 'jump'          bare `jump X` at the label's top level; safe to maintain.
 *  - 'fallthrough'   no terminator, so Ren'Py runs into the next label in FILE
 *                    ORDER. An implicit jump: reordering must materialise it
 *                    into an explicit `jump` first or the story silently rewires.
 *  - 'hand-authored' ends in menu:/return/call/if; never rewritten.
 */
export type LabelEndKind = 'jump' | 'fallthrough' | 'hand-authored'

/** Where a label actually sits in the file. Derived on parse, never persisted. */
export interface LabelSpan {
  label: string
  /** 1-indexed, inclusive. */
  startLine: number
  endLine: number
  endKind: LabelEndKind
  /** Target of the bare trailing jump, when endKind is 'jump'. */
  trailingJump: string | null
  /** Label implicitly run into, when endKind is 'fallthrough'. */
  fallsThroughTo: string | null
  /**
   * Nothing has been written here yet.
   *
   * A label whose body is only structure -- a `pass`, a jump, a return, a
   * blank line -- is a scene somebody has planned and not written. It is a
   * real label, so the script runs and the beat can be opened and typed
   * into; it just has nothing in it.
   */
  empty: boolean
}

export interface ParsedEpisode {
  fileName: string
  labels: LabelSpan[]
  lineCount: number
  /** File began with a UTF-8 BOM; must be preserved on write. */
  hadBom: boolean
}

// -------------------------------------------------------------- characters

export interface Character {
  id: string
  /** Ren'Py variable name, e.g. 'alice'. */
  varName: string
  /** Display name from Character('Alice', ...). */
  name: string
  birthday?: string
  age?: string
  bio?: string
  /** Feeds the translation pass, e.g. 'Southerner', 'Ghetto'. */
  accent?: string
  relations?: string
  storyHooks?: string
  /** Expressions discovered from `image side <varName> <expr>`. */
  expressions: string[]
  color?: string
}

/** A character as discovered by scanning the project's own .rpy files. */
export interface DiscoveredCharacter {
  /** Ren'Py variable, e.g. 'alice'. */
  varName: string
  /** Display name from Character('Alice', ...). */
  name: string
  color?: string
  /** The image tag this character speaks with, from image="alice". */
  imageTag?: string
  /** Expressions available for that tag, from `image side <tag> <expr>`. */
  expressions: string[]
  /** File the define lives in, relative to the project root. */
  sourceFile?: string
  /** 1-indexed line of the define, so the name can be edited in place. */
  sourceLine?: number
  /** Expression -> portrait path relative to game/, for previews. */
  portraits: Record<string, string>
  /** The attribute-less portrait, used when no expression is set. */
  defaultPortrait?: string
}

// -------------------------------------------------------------------- notes

/**
 * A character profile. Profiles are created deliberately, never imported from
 * the script, and one profile can cover several Ren'Py variables: alice,
 * alice_thoughts and alice_nvl are one person even though the engine needs
 * three definitions.
 */
export interface CharacterNote {
  id: string
  /** Script variables this profile covers. Empty for someone not yet written. */
  varNames: string[]
  /** The name used in notes. Script display names stay per-variable. */
  name: string
  /**
   * Who they are, as opposed to what the script calls them. A character the
   * game only ever names as Detective Cook can be James Cook here, and the
   * script is left saying what it says.
   */
  fullName?: string
  birthday?: string
  age?: string
  /**
   * Accent, slang or dialect, e.g. 'Southerner' or 'Ghetto'.
   * The translation pass reads this to flavour a character's voice.
   */
  accent?: string
  bio?: string
  trivia?: string
  relations?: string
  storyHooks?: string
  /** Legacy single-variable field, migrated on read. */
  varName?: string | null
}

export interface LocationNote {
  id: string
  name: string
  description?: string
  notes?: string
}

export interface FreeNote {
  id: string
  title: string
  body: string
  updatedAt: string
}

/** .renpywriter/characters.json */
export interface SidecarCharacters {
  version: 1
  characters: CharacterNote[]
  characterOrder?: string[]
}

/** .renpywriter/locations.json */
export interface SidecarLocations {
  version: 1
  locations: LocationNote[]
}

/** .renpywriter/notes.json */
export interface SidecarNotes {
  version: 1
  notes: FreeNote[]
}

/** Everything the reference panel needs, loaded in one round trip. */
export interface Reference {
  characters: CharacterNote[]
  locations: LocationNote[]
  notes: FreeNote[]
  /** Profile ids in display order; anything missing sorts after, by name. */
  characterOrder: string[]
}

// ------------------------------------------------------------------ sidecar

/** .renpywriter/project.json */
export interface SidecarProject {
  version: 1
  id: string
  name: string
  settings: ProjectSettings
  episodes: Episode[]
  createdAt: string
}

/** .renpywriter/outline.json */
export interface SidecarOutline {
  version: 1
  beats: Beat[]
}

// ---------------------------------------------------------------- transport

export interface DirEntry {
  name: string
  isDirectory: boolean
}

export interface RenpyRootCheck {
  valid: boolean
  /** Directories under game/ that contain .rpy files, as scriptDir candidates. */
  scriptDirCandidates: string[]
  reason?: string
}
