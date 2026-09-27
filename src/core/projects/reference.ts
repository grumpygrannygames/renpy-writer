import type {
  CharacterNote,
  Reference,
  SidecarCharacters,
  SidecarLocations,
  SidecarNotes
} from '@shared/types'
import { SIDECAR_DIR } from '@shared/types'
import type { WorkspaceProvider } from '../workspace/WorkspaceProvider'

const CHARACTERS_FILE = `${SIDECAR_DIR}/characters.json`
const LOCATIONS_FILE = `${SIDECAR_DIR}/locations.json`
const NOTES_FILE = `${SIDECAR_DIR}/notes.json`

/**
 * Reference material lives in three files rather than one so that edits to the
 * cast, the places and free notes stay in separate git diffs.
 */
async function readJson<T>(ws: WorkspaceProvider, file: string, fallback: T): Promise<T> {
  // Missing is normal: a project that has no notes yet.
  if (!(await ws.exists(file))) return fallback
  let text: string
  try {
    text = await ws.readText(file)
  } catch (e) {
    throw new UnreadableReferenceError(file, e instanceof Error ? e.message : String(e))
  }
  try {
    return JSON.parse(text) as T
  } catch {
    /*
     * Present but unreadable is not the same as empty, and treating it as
     * empty is how four character profiles were lost: a file left at 0 bytes
     * read as "no characters", nothing said so, and the next save of any note
     * wrote the empty list back over the real one. So this refuses, and the
     * refusal is what stops everything downstream from writing over it.
     */
    throw new UnreadableReferenceError(
      file,
      text.trim().length === 0 ? 'the file is empty' : 'it is not valid JSON'
    )
  }
}

/**
 * A notes file that is there but cannot be read. Carries the file, so the
 * message can say which one and what to do about it.
 */
export class UnreadableReferenceError extends Error {
  constructor(
    readonly file: string,
    readonly why: string
  ) {
    super(
      `${file} could not be read (${why}), so no notes are being saved over it. ` +
        `Restore it from git (git checkout -- ${file}) and reopen the project.`
    )
    this.name = 'UnreadableReferenceError'
  }
}

/**
 * Profiles used to hold a single `varName`. Fold that into the list form so
 * files written by an earlier version keep working.
 */
function migrate(character: CharacterNote): CharacterNote {
  if (Array.isArray(character.varNames)) {
    const { varName: _legacy, ...rest } = character
    return { ...rest, varNames: character.varNames.filter(Boolean) }
  }
  const legacy = character.varName
  const { varName: _drop, ...rest } = character
  return { ...rest, varNames: legacy ? [legacy] : [] }
}

export async function readReference(ws: WorkspaceProvider): Promise<Reference> {
  const [characters, locations, notes] = await Promise.all([
    readJson<SidecarCharacters>(ws, CHARACTERS_FILE, { version: 1, characters: [] }),
    readJson<SidecarLocations>(ws, LOCATIONS_FILE, { version: 1, locations: [] }),
    readJson<SidecarNotes>(ws, NOTES_FILE, { version: 1, notes: [] })
  ])
  return {
    characters: (characters.characters ?? []).map(migrate),
    characterOrder: characters.characterOrder ?? [],
    locations: locations.locations ?? [],
    notes: notes.notes ?? []
  }
}

/**
 * Write the reference, one file at a time and only where something changed.
 *
 * All three used to be rewritten on every save, so editing a note rewrote the
 * cast from whatever happened to be in memory. If memory was wrong, a note
 * edit destroyed the characters -- which is exactly what happened. Now a note
 * edit touches notes.json and nothing else, and the git history says so too.
 */
export async function writeReference(ws: WorkspaceProvider, ref: Reference): Promise<void> {
  const write = async (file: string, body: unknown): Promise<void> => {
    const next = JSON.stringify(body, null, 2) + '\n'
    if ((await ws.exists(file)) && (await ws.readText(file)) === next) return
    await ws.writeText(file, next)
  }

  await Promise.all([
    write(CHARACTERS_FILE, {
      version: 1,
      characters: ref.characters,
      characterOrder: ref.characterOrder
    } satisfies SidecarCharacters),
    write(LOCATIONS_FILE, { version: 1, locations: ref.locations } satisfies SidecarLocations),
    write(NOTES_FILE, { version: 1, notes: ref.notes } satisfies SidecarNotes)
  ])
}
