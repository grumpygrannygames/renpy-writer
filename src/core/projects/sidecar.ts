import { randomUUID } from 'node:crypto'
import type {
  Beat,
  Episode,
  ParsedEpisode,
  ProjectSettings,
  SidecarOutline,
  SidecarProject
} from '@shared/types'
import { SIDECAR_DIR } from '@shared/types'
import type { WorkspaceProvider } from '../workspace/WorkspaceProvider'

const PROJECT_FILE = `${SIDECAR_DIR}/project.json`
const OUTLINE_FILE = `${SIDECAR_DIR}/outline.json`

/**
 * Sidecar state is split across two files so that a proofreader editing beats
 * and a writer editing settings do not collide in the same git diff.
 */
export async function readSidecarProject(ws: WorkspaceProvider): Promise<SidecarProject | null> {
  if (!(await ws.exists(PROJECT_FILE))) return null
  try {
    return JSON.parse(await ws.readText(PROJECT_FILE)) as SidecarProject
  } catch {
    return null
  }
}

export async function writeSidecarProject(
  ws: WorkspaceProvider,
  project: SidecarProject
): Promise<void> {
  await ws.writeText(PROJECT_FILE, JSON.stringify(project, null, 2) + '\n')
}

export async function readOutline(ws: WorkspaceProvider): Promise<SidecarOutline> {
  if (!(await ws.exists(OUTLINE_FILE))) return { version: 1, beats: [] }
  try {
    const parsed = JSON.parse(await ws.readText(OUTLINE_FILE)) as SidecarOutline
    return { version: 1, beats: parsed.beats ?? [] }
  } catch {
    return { version: 1, beats: [] }
  }
}

export async function writeOutline(ws: WorkspaceProvider, outline: SidecarOutline): Promise<void> {
  await ws.writeText(OUTLINE_FILE, JSON.stringify(outline, null, 2) + '\n')
}

export function newSidecarProject(
  name: string,
  settings: ProjectSettings,
  episodes: Episode[] = []
): SidecarProject {
  return {
    version: 1,
    id: randomUUID(),
    name,
    settings,
    episodes,
    createdAt: new Date().toISOString()
  }
}

/**
 * Reconcile outline metadata against the labels actually present in a file.
 *
 * Labels found on disk that have no beat yet get one. Beats whose label has
 * disappeared are kept, not deleted -- they become unwritten outline beats so
 * a rename in an external editor never destroys the notes attached to them.
 */
export function reconcileBeats(
  existing: Beat[],
  episodeId: string,
  labelsInFile: string[]
): Beat[] {
  const mine = existing.filter((b) => b.episodeId === episodeId)
  /*
   * Beats waiting for each label, in the order they were in.
   *
   * A list rather than one beat per name, because a script can define the
   * same label twice -- Ren'Py will refuse it, but a draft gets that way. A
   * map of one beat per name kept only the last of them: the first was
   * dropped outright, notes and all, and the second occurrence minted a new
   * beat, so every open rewrote the outline with a fresh id and lost a beat.
   * Taken in order, the nth time a name appears gets the nth beat with it,
   * and opening twice gives the same outline both times.
   */
  const byLabel = new Map<string, Beat[]>()
  for (const b of [...mine].sort((a, c) => a.order - c.order)) {
    if (b.label) byLabel.set(b.label, [...(byLabel.get(b.label) ?? []), b])
  }
  const result: Beat[] = []

  labelsInFile.forEach((label, i) => {
    const found = byLabel.get(label)?.shift()
    if (found) {
      result.push({ ...found, order: i })
    } else {
      result.push({
        id: randomUUID(),
        episodeId,
        label,
        title: label,
        order: i
      })
    }
  })

  // Beats whose label vanished, plus outline-only beats, keep their metadata.
  let tail = result.length
  for (const orphan of [...[...byLabel.values()].flat(), ...mine.filter((b) => !b.label)]) {
    result.push({ ...orphan, label: null, order: tail++ })
  }

  return [...existing.filter((b) => b.episodeId !== episodeId), ...result]
}

/**
 * Every label defined more than once across the episodes, said plainly.
 *
 * Ren'Py labels are global and must be unique: a second definition stops the
 * game at launch. Nothing in the editor stops one being typed, though, and a
 * draft can sit outside the game folder for weeks with one in it -- found
 * only when the chapter goes in and the game will not start. Said on opening
 * instead, with where each one is.
 */
export function duplicateLabelWarnings(parsed: Record<string, ParsedEpisode>): string[] {
  const where = new Map<string, string[]>()
  for (const [file, episode] of Object.entries(parsed)) {
    for (const span of episode.labels) {
      where.set(span.label, [...(where.get(span.label) ?? []), `${file} line ${span.startLine}`])
    }
  }
  return [...where]
    .filter(([, at]) => at.length > 1)
    .map(
      ([label, at]) =>
        `label ${label} is defined ${at.length === 2 ? 'twice' : `${at.length} times`} ` +
        `(${at.join(', ')}). Ren'Py will not start until each has a name of its own.`
    )
}
