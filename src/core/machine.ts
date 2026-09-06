import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import type { Episode, ProjectSettings, RenderEncoder } from '@shared/types'

/**
 * Settings that belong to this computer rather than to the project.
 *
 * The sidecar in the game folder is meant to be shared -- committed, cloned,
 * opened by a proofreader on a Mac. Anything in it that names a path on one
 * particular machine is broken everywhere else, so those values live here
 * instead, beside the project registry in userData.
 *
 * The split is by ownership, not by convenience. Which folder renders come
 * from, and which encoder converts them, are facts about a machine. Where
 * images go inside the game, what languages it is written in, whether the
 * story is linear: those are facts about the project and stay in the sidecar.
 */
export interface MachineProject {
  /** Encoder overrides. Absent means the built-in one. */
  renderEncoder?: RenderEncoder
  ffmpegPath?: string
  /** Absolute path to each episode's render folder, by episode id. */
  renderSources?: Record<string, string>
}

interface MachineFile {
  version: 1
  projects: Record<string, MachineProject>
}

/** Where the file lives. Set once by whoever is hosting this code. */
let settingsDir = ''

export function useSettingsDir(dir: string): void {
  settingsDir = dir
}

function machinePath(): string {
  if (!settingsDir) throw new Error('No settings folder has been chosen yet.')
  return path.join(settingsDir, 'machine.json')
}

async function readAll(): Promise<MachineFile> {
  try {
    const parsed = JSON.parse(await fs.readFile(machinePath(), 'utf8')) as MachineFile
    return { version: 1, projects: parsed.projects ?? {} }
  } catch {
    // Missing or unreadable: a machine with no local overrides is the normal
    // state on a fresh clone, and nothing here is irreplaceable.
    return { version: 1, projects: {} }
  }
}

async function writeAll(file: MachineFile): Promise<void> {
  const target = machinePath()
  await fs.mkdir(path.dirname(target), { recursive: true })
  const temp = target + '.tmp'
  await fs.writeFile(temp, JSON.stringify(file, null, 2) + '\n', 'utf8')
  await fs.rename(temp, target)
}

export async function readMachineProject(projectId: string): Promise<MachineProject> {
  return (await readAll()).projects[projectId] ?? {}
}

export async function updateMachineProject(
  projectId: string,
  patch: (current: MachineProject) => MachineProject
): Promise<MachineProject> {
  const all = await readAll()
  const next = patch(all.projects[projectId] ?? {})
  all.projects[projectId] = next
  await writeAll(all)
  return next
}

/** Fold this machine's overrides into the settings the app works with. */
export function withMachineSettings(
  settings: ProjectSettings,
  machine: MachineProject
): ProjectSettings {
  const merged: ProjectSettings = { ...settings }
  if (machine.renderEncoder) merged.renderEncoder = machine.renderEncoder
  if (machine.ffmpegPath !== undefined) merged.ffmpegPath = machine.ffmpegPath
  return merged
}

/** Strip machine-owned values, leaving what belongs in the shared sidecar. */
export function withoutMachineSettings(settings: ProjectSettings): ProjectSettings {
  const shared = { ...settings }
  delete shared.renderEncoder
  delete shared.ffmpegPath
  return shared
}

/** Attach this machine's render folders to the episodes as loaded. */
export function withMachineRenders(episodes: Episode[], machine: MachineProject): Episode[] {
  const sources = machine.renderSources ?? {}
  return episodes.map((ep) => {
    if (!ep.renders) {
      // A render folder known only here still gives the episode a config, so
      // the panel opens with the path already filled in.
      const sourceDir = sources[ep.id]
      return sourceDir ? { ...ep, renders: { sourceDir, targetSubdir: '' } } : ep
    }
    return { ...ep, renders: { ...ep.renders, sourceDir: sources[ep.id] ?? '' } }
  })
}

/** Remove render folders before the episodes are written to the sidecar. */
export function withoutMachineRenders(episodes: Episode[]): Episode[] {
  return episodes.map((ep) => {
    if (!ep.renders) return ep
    const { sourceDir: _dropped, ...shared } = ep.renders
    return { ...ep, renders: shared as Episode['renders'] }
  })
}
