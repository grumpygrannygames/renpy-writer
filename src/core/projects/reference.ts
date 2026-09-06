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
  if (!(await ws.exists(file))) return fallback
  try {
    return JSON.parse(await ws.readText(file)) as T
  } catch {
    // A corrupt or hand-edited file should not take the panel down.
    return fallback
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

export async function writeReference(ws: WorkspaceProvider, ref: Reference): Promise<void> {
  const write = (file: string, body: unknown): Promise<void> =>
    ws.writeText(file, JSON.stringify(body, null, 2) + '\n')

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
