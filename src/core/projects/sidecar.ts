import { randomUUID } from 'node:crypto'
import type {
  Beat,
  Episode,
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
  const byLabel = new Map(mine.filter((b) => b.label).map((b) => [b.label as string, b]))
  const result: Beat[] = []

  labelsInFile.forEach((label, i) => {
    const found = byLabel.get(label)
    if (found) {
      result.push({ ...found, order: i })
      byLabel.delete(label)
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
  for (const orphan of [...byLabel.values(), ...mine.filter((b) => !b.label)]) {
    result.push({ ...orphan, label: null, order: tail++ })
  }

  return [...existing.filter((b) => b.episodeId !== episodeId), ...result]
}
