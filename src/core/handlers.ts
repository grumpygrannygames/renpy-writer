import { randomUUID } from 'node:crypto'
import type {
  HostCapabilities,
  ProjectListing,
  CreateEpisodeInput,
  CreateProjectInput,
  OpenedProject
} from '@shared/api'
import { IPC } from '@shared/api'
import type {
  Episode,
  EpisodeStatus,
  ParsedEpisode,
  Project,
  ProjectRef,
  ProjectSettings,
  Reference,
  RenderConfig,
  SidecarProject
} from '@shared/types'
import { DRAFTS_DIR } from '@shared/types'
import { LocalWorkspaceProvider } from '@core/workspace/LocalWorkspaceProvider'
import { checkRenpyRoot, listScriptFiles, toFileSlug } from '@core/renpy/detect'
import { parseEpisode } from '@core/renpy/labels'
import { moveBeat } from '@core/renpy/restructure'
import { runPass } from '@core/passes'
import {
  BUILT_IN_ENCODER,
  convertBatch,
  clampQuality,
  findFfmpeg,
  planRenderSync,
  type BuiltInEncode
} from './renders'
import {
  commit as gitCommit,
  fetchStatus as gitFetchStatus,
  pull as gitPull,
  push as gitPush,
  readStatus,
  resolvePull as gitResolvePull
} from '@core/git'
import type { Decision } from '@core/git/conflicts'
import { cliRunner } from '@core/passes/runner'
import { scanCharacters } from '@core/renpy/characters'
import { renameCharacter } from '@core/renpy/rename'
import { readPortrait, resolveImageName } from '@core/renpy/images'
import {
  newSidecarProject,
  readOutline,
  readSidecarProject,
  reconcileBeats,
  writeOutline,
  writeSidecarProject
} from '@core/projects/sidecar'
import {
  withMachineRenders,
  withMachineSettings,
  withoutMachineRenders,
  withoutMachineSettings,
  type MachineProject
} from './machine'
import { readReference, writeReference } from '@core/projects/reference'

const providers = new Map<string, LocalWorkspaceProvider>()

function ws(root: string): LocalWorkspaceProvider {
  let p = providers.get(root)
  if (!p) {
    p = new LocalWorkspaceProvider(root)
    providers.set(root, p)
  }
  return p
}

/**
 * Where an episode's file lives.
 *
 * Drafts sit in the sidecar, which Ren'Py never loads and the default build
 * rules exclude from distributions, so an unreleased episode cannot be found
 * by anyone inspecting the shipped game files.
 */
function episodeRel(
  settings: ProjectSettings,
  fileName: string,
  status: EpisodeStatus = 'release'
): string {
  return status === 'draft'
    ? `${DRAFTS_DIR}/${fileName}`
    : ['game', settings.scriptDir, fileName].filter(Boolean).join('/')
}

const relOf = (settings: ProjectSettings, ep: Episode): string =>
  episodeRel(settings, ep.fileName, ep.status ?? 'release')

/** Resolve an episode file by name, wherever it currently lives. */
async function locate(
  root: string,
  fileName: string
): Promise<{ provider: LocalWorkspaceProvider; rel: string }> {
  const provider = ws(root)
  const sidecar = await readSidecarProject(provider)
  if (!sidecar) throw new Error(`No project found at ${root}`)
  const ep = sidecar.episodes.find((e) => e.fileName === fileName)
  return {
    provider,
    rel: ep ? relOf(sidecar.settings, ep) : episodeRel(sidecar.settings, fileName)
  }
}

/**
 * Load a project from its sidecar, refresh beats against the labels actually
 * on disk, and report any script files not yet adopted as episodes.
 *
 * Reading never rewrites a .rpy file -- only the sidecar is touched.
 */
/**
 * Move anything machine-owned out of a sidecar written before the split.
 *
 * Done on load rather than by a version bump, because the value that matters
 * -- an absolute path to a Blender folder -- is actively wrong for anyone else
 * who opens the project, and it should stop travelling the first time the file
 * is touched rather than whenever a migration is remembered.
 */
async function migrateMachineValues(
  host: HostServices,
  provider: LocalWorkspaceProvider,
  sidecar: SidecarProject
): Promise<SidecarProject> {
  const strayEpisodes = sidecar.episodes.filter((e) => e.renders?.sourceDir)
  const straySettings =
    sidecar.settings.ffmpegPath !== undefined || sidecar.settings.renderEncoder !== undefined
  if (strayEpisodes.length === 0 && !straySettings) return sidecar

  await host.machine.update(sidecar.id, (current) => ({
    ...current,
    // A value already known locally wins: it describes this machine, whereas
    // the one in the file describes whichever machine last wrote it.
    renderEncoder: current.renderEncoder ?? sidecar.settings.renderEncoder,
    ffmpegPath: current.ffmpegPath ?? sidecar.settings.ffmpegPath,
    renderSources: {
      ...Object.fromEntries(strayEpisodes.map((e) => [e.id, e.renders!.sourceDir!])),
      ...(current.renderSources ?? {})
    }
  }))

  const cleaned: SidecarProject = {
    ...sidecar,
    settings: withoutMachineSettings(sidecar.settings),
    episodes: withoutMachineRenders(sidecar.episodes)
  }
  await writeSidecarProject(provider, cleaned)
  return cleaned
}

async function loadProject(host: HostServices, renpyRoot: string): Promise<OpenedProject> {
  // Where the list is the operator's rather than the user's, only what is on
  // it can be opened. Otherwise anyone who signs in could name any path the
  // server can reach and read whatever is there.
  if (!host.capabilities.manageProjects) {
    const known = await host.registry.read()
    if (!known.projects.some((p) => p.renpyRoot === renpyRoot)) {
      throw new Error(
        'That project is not one this server was given. Projects here are set when the ' +
          'server is started, with --project.'
      )
    }
  }

  // A host that shares a checkout brings it up to date first; one that does
  // not implement this is somebody's own machine, where syncing is their call.
  await host.beforeOpenProject?.(renpyRoot)

  const provider = ws(renpyRoot)
  let sidecar = await readSidecarProject(provider)
  if (!sidecar) throw new Error(`No project found at ${renpyRoot}`)

  sidecar = await migrateMachineValues(host, provider, sidecar)
  const machine = await host.machine.read(sidecar.id)

  const outline = await readOutline(provider)
  let beats = outline.beats
  const parsedEpisodes: Record<string, ParsedEpisode> = {}

  for (const ep of sidecar.episodes) {
    const rel = relOf(sidecar.settings, ep)
    if (await provider.exists(rel)) {
      const parsed = parseEpisode(ep.fileName, await provider.readText(rel))
      parsedEpisodes[ep.fileName] = parsed
      beats = reconcileBeats(beats, ep.id, parsed.labels.map((l) => l.label))
    } else {
      beats = reconcileBeats(beats, ep.id, [])
    }
  }

  if (JSON.stringify(beats) !== JSON.stringify(outline.beats)) {
    await writeOutline(provider, { version: 1, beats })
  }

  const onDisk = await listScriptFiles(renpyRoot, sidecar.settings.scriptDir)
  const registered = new Set(sidecar.episodes.map((e) => e.fileName))

  const project: Project = {
    id: sidecar.id,
    name: sidecar.name,
    renpyRoot,
    settings: withMachineSettings(sidecar.settings, machine),
    createdAt: sidecar.createdAt,
    lastOpenedAt: new Date().toISOString()
  }

  await host.registry.upsert({
    id: project.id,
    name: project.name,
    renpyRoot,
    lastOpenedAt: project.lastOpenedAt
  })

  return {
    project,
    episodes: withMachineRenders(sidecar.episodes, machine).sort((a, b) => a.order - b.order),
    beats,
    unregisteredFiles: onDisk.filter((f) => !registered.has(f)),
    parsedEpisodes
  }
}

/**
 * Every operation the interface can ask for, in one place, with nothing in it
 * that belongs to a particular way of being reached.
 *
 * Electron registers these on IPC channels; a server registers the same set on
 * HTTP routes. Neither transport holds any logic, so the two cannot drift --
 * there is one implementation and two doors into it.
 *
 * What genuinely differs between hosts arrives through HostServices: a desktop
 * opens a folder picker and keeps its lists in JSON files beside the app, while
 * a server has no picker at all and would keep the same lists per account.
 */

/** How a transport is told about a handler. Its first argument is dropped. */
export type Register = (
  channel: string,
  handler: (...args: never[]) => unknown
) => void

export interface HostServices {
  /** Ask the person for a folder. A server has no way to do this. */
  pickFolder(): Promise<string | null>
  /** Which projects this installation knows about. */
  registry: {
    read(): Promise<ProjectListing>
    upsert(ref: ProjectRef): Promise<ProjectRef[]>
    remove(id: string): Promise<ProjectRef[]>
  }
  /** Settings that belong to this machine or account rather than the project. */
  machine: {
    read(projectId: string): Promise<MachineProject>
    update(
      projectId: string,
      patch: (current: MachineProject) => MachineProject
    ): Promise<MachineProject>
  }
  /** An image encoder the host can offer, if it has one. */
  builtinEncoder?: BuiltInEncode
  /** What this installation supports, so the interface can leave out the rest. */
  capabilities: HostCapabilities
  /**
   * Who is making this request, when the host knows.
   *
   * A desktop is one person at their own machine and git already knows their
   * name. A server is many people sharing one checkout, so it has to say.
   */
  currentAuthor?(): Promise<{ name: string; email: string } | null>
  /**
   * Anything the host wants done before a project is read -- a server pulls,
   * so a phone is not shown a script somebody replaced an hour ago.
   */
  beforeOpenProject?(renpyRoot: string): Promise<void>
}

export function registerHandlers(register: Register, host: HostServices): void {
  register(IPC.listProjects, () => host.registry.read())

  register(IPC.pickFolder, () => host.pickFolder())

  register(IPC.checkRoot, (root: string) => checkRenpyRoot(root))

  register(IPC.createProject, async (input: CreateProjectInput) => {
    if (!host.capabilities.manageProjects) {
      throw new Error('Projects cannot be added from here. They are set when the server starts.')
    }
    const provider = ws(input.renpyRoot)
    const existing = await readSidecarProject(provider)
    if (existing) throw new Error('That folder already has a Ren\u2019Py Writer project.')

    const sidecar = newSidecarProject(input.name, withoutMachineSettings(input.settings))
    await writeSidecarProject(provider, sidecar)
    await host.machine.update(sidecar.id, (current) => ({
      ...current,
      renderEncoder: input.settings.renderEncoder,
      ffmpegPath: input.settings.ffmpegPath
    }))
    await writeOutline(provider, { version: 1, beats: [] })
    return loadProject(host, input.renpyRoot)
  })

  register(IPC.openProject, (root: string) => loadProject(host, root))

  register(IPC.removeProject, (id: string) => {
    if (!host.capabilities.manageProjects) {
      throw new Error('Projects cannot be removed from here. They are set when the server starts.')
    }
    return host.registry.remove(id)
  })

  register(IPC.updateSettings, async (root: string, settings: ProjectSettings) => {
    const provider = ws(root)
    const sidecar = await readSidecarProject(provider)
    if (!sidecar) throw new Error(`No project found at ${root}`)

    // The encoder belongs to this computer; everything else belongs to the
    // project and goes in the file that other people will open.
    await host.machine.update(sidecar.id, (current) => ({
      ...current,
      renderEncoder: settings.renderEncoder,
      ffmpegPath: settings.ffmpegPath
    }))
    await writeSidecarProject(provider, {
      ...sidecar,
      settings: withoutMachineSettings(settings)
    })
    return (await loadProject(host, root)).project
  })

  register(IPC.scanCharacters, (root: string) => scanCharacters(root))

  register(IPC.readPortrait, (root: string, rel: string) => readPortrait(root, rel))

  register(
    IPC.renameCharacter,
    async (root: string, varName: string, newName: string) => {
      const cast = await scanCharacters(root)
      const target = cast.find((c) => c.varName === varName)
      if (!target?.sourceFile || !target.sourceLine) {
        return { ok: false, reason: `${varName} is not defined in this project.`, characters: cast }
      }
      const result = await renameCharacter(
        ws(root),
        target.sourceFile,
        target.sourceLine,
        varName,
        newName
      )
      // Rescan either way so the caller always sees the current truth.
      return { ...result, characters: await scanCharacters(root) }
    }
  )

  register(IPC.resolveImage, (root: string, name: string) =>
    resolveImageName(root, name))

  register(IPC.readReference, (root: string) => readReference(ws(root)))

  register(IPC.writeReference, (root: string, reference: Reference) =>
    writeReference(ws(root), reference))

  register(IPC.createEpisode, async (input: CreateEpisodeInput) => {
    const provider = ws(input.renpyRoot)
    const sidecar = await readSidecarProject(provider)
    if (!sidecar) throw new Error(`No project found at ${input.renpyRoot}`)

    const fileName =
      input.mode === 'import' ? input.fileName! : `${toFileSlug(input.name)}.rpy`
    if (sidecar.episodes.some((e) => e.fileName === fileName)) {
      throw new Error(`${fileName} is already an episode in this project.`)
    }

    const status: EpisodeStatus = input.status ?? 'release'
    const rel = episodeRel(sidecar.settings, fileName, status)
    if (input.mode === 'new') {
      if (await provider.exists(rel)) {
        throw new Error(`${fileName} already exists. Use Import instead.`)
      }
      const label = toFileSlug(input.name).toUpperCase() + '_START'
      await provider.writeText(rel, `label ${label}:\n\n    return\n`)
    } else if (!(await provider.exists(rel))) {
      throw new Error(`${fileName} was not found in the script folder.`)
    }

    const episode: Episode = {
      id: randomUUID(),
      name: input.name,
      fileName,
      order: sidecar.episodes.length,
      status
    }
    await writeSidecarProject(provider, {
      ...sidecar,
      episodes: [...sidecar.episodes, episode]
    })
    return loadProject(host, input.renpyRoot)
  })

  register(IPC.parseEpisode, async (root: string, fileName: string) => {
    const { provider, rel } = await locate(root, fileName)
    return parseEpisode(fileName, await provider.readText(rel))
  })

  register(IPC.readEpisode, async (root: string, fileName: string) => {
    const { provider, rel } = await locate(root, fileName)
    return provider.readText(rel)
  })

  register(
    IPC.writeEpisode,
    async (root: string, fileName: string, content: string) => {
      const { provider, rel } = await locate(root, fileName)
      await provider.writeText(rel, content)
    }
  )

  register(
    IPC.runScriptPass,
    async (
      root: string,
      input: { fileName: string; mode: 'translate' | 'proofread'; lines?: number[] }
    ) => {
      const provider = ws(root)
      const sidecar = await readSidecarProject(provider)
      if (!sidecar) throw new Error(`No project found at ${root}`)

      const { rel } = await locate(root, input.fileName)
      const previous = await provider.readText(rel)

      const [cast, reference] = await Promise.all([
        scanCharacters(root),
        readReference(provider)
      ])

      const result = await runPass(
        previous,
        {
          mode: input.mode,
          sourceLanguage: sidecar.settings.sourceLanguage,
          targetLanguage: sidecar.settings.targetLanguage,
          lines: input.lines,
          cast,
          profiles: reference.characters
        },
        cliRunner(sidecar.settings.translateCommand?.trim() || 'claude')
      )

      if (result.error) {
        return { changes: [], skipped: result.skipped, previous, error: result.error }
      }
      if (result.changes.length > 0) await provider.writeText(rel, result.content)
      return { changes: result.changes, skipped: result.skipped, previous }
    }
  )

  register(IPC.reorderEpisodes, async (root: string, ids: string[]) => {
    const provider = ws(root)
    const sidecar = await readSidecarProject(provider)
    if (!sidecar) throw new Error(`No project found at ${root}`)
    const rank = new Map(ids.map((id, i) => [id, i]))
    const episodes = sidecar.episodes
      .map((ep) => ({ ...ep, order: rank.get(ep.id) ?? ep.order + ids.length }))
      .sort((a, b) => a.order - b.order)
      .map((ep, i) => ({ ...ep, order: i }))
    await writeSidecarProject(provider, { ...sidecar, episodes })
    return loadProject(host, root)
  })

  register(
    IPC.setEpisodeStatus,
    async (root: string, episodeId: string, status: EpisodeStatus) => {
      const provider = ws(root)
      const sidecar = await readSidecarProject(provider)
      if (!sidecar) throw new Error(`No project found at ${root}`)
      const ep = sidecar.episodes.find((e) => e.id === episodeId)
      if (!ep) throw new Error('That episode is no longer in the project.')

      const current = ep.status ?? 'release'
      if (current !== status) {
        const fromRel = episodeRel(sidecar.settings, ep.fileName, current)
        const toRel = episodeRel(sidecar.settings, ep.fileName, status)
        if (await provider.exists(toRel)) {
          throw new Error(`${toRel} already exists. Move or rename it first.`)
        }
        if (await provider.exists(fromRel)) {
          // Write the copy before deleting, so a failure never loses a script.
          await provider.writeText(toRel, await provider.readText(fromRel))
          await provider.remove(fromRel)
        }
      }

      await writeSidecarProject(provider, {
        ...sidecar,
        episodes: sidecar.episodes.map((e) => (e.id === episodeId ? { ...e, status } : e))
      })
      return loadProject(host, root)
    }
  )

  register(IPC.createBeat, async (root: string, episodeId: string, title: string) => {
    const provider = ws(root)
    const sidecar = await readSidecarProject(provider)
    if (!sidecar) throw new Error(`No project found at ${root}`)
    if (!sidecar.episodes.some((e) => e.id === episodeId)) {
      throw new Error('That episode is no longer in the project.')
    }
    const named = title.trim()
    if (!named) throw new Error('A beat needs a name.')

    const outline = await readOutline(provider)
    // Added at the end of its own episode, which is where a new idea goes
    // when nobody has said otherwise.
    const last = outline.beats
      .filter((b) => b.episodeId === episodeId)
      .reduce((n, b) => Math.max(n, b.order + 1), 0)
    await writeOutline(provider, {
      version: 1,
      beats: [
        ...outline.beats,
        { id: randomUUID(), episodeId, label: null, title: named, order: last }
      ]
    })
    return loadProject(host, root)
  })

  register(
    IPC.updateBeat,
    async (root: string, beatId: string, changes: { title?: string; description?: string }) => {
      const provider = ws(root)
      const outline = await readOutline(provider)
      const beat = outline.beats.find((b) => b.id === beatId)
      if (!beat) throw new Error('That beat is no longer in the outline.')

      const title = changes.title === undefined ? beat.title : changes.title.trim()
      if (!title) throw new Error('A beat needs a name.')
      const description =
        changes.description === undefined ? beat.description : changes.description

      await writeOutline(provider, {
        version: 1,
        beats: outline.beats.map((b) =>
          b.id === beatId ? { ...b, title, description } : b
        )
      })
      return loadProject(host, root)
    }
  )

  register(IPC.removeBeat, async (root: string, beatId: string) => {
    const provider = ws(root)
    const outline = await readOutline(provider)
    const beat = outline.beats.find((b) => b.id === beatId)
    if (!beat) throw new Error('That beat is no longer in the outline.')
    if (beat.label) {
      throw new Error(
        `“${beat.title}” is written: ${beat.label} is a label in the script. Remove it from ` +
          'the script and it will leave the outline by itself.'
      )
    }
    await writeOutline(provider, {
      version: 1,
      beats: outline.beats.filter((b) => b.id !== beatId)
    })
    return loadProject(host, root)
  })

  register(IPC.capabilities, async () => host.capabilities)

  register(IPC.gitStatus, (root: string) => readStatus(root))
  register(IPC.gitFetchStatus, (root: string) => gitFetchStatus(root))
  register(IPC.gitPull, (root: string) => gitPull(root))
  register(
    IPC.gitCommit,
    async (root: string, input: { message: string; paths: string[]; push?: boolean }) =>
      gitCommit(root, { ...input, author: (await host.currentAuthor?.()) ?? undefined })
  )
  register(IPC.gitPush, async (root: string) =>
    gitPush(root, (await host.currentAuthor?.()) ?? undefined)
  )
  register(IPC.gitResolvePull, (root: string, decisions: Decision[]) =>
    gitResolvePull(root, decisions)
  )

  register(
    IPC.setEpisodeRenders,
    async (root: string, episodeId: string, renders: RenderConfig | null) => {
      const provider = ws(root)
      const sidecar = await readSidecarProject(provider)
      if (!sidecar) throw new Error(`No project found at ${root}`)
      if (!sidecar.episodes.some((e) => e.id === episodeId)) {
        throw new Error('That episode is no longer in the project.')
      }

      await host.machine.update(sidecar.id, (current) => {
        const sources = { ...(current.renderSources ?? {}) }
        if (renders?.sourceDir) sources[episodeId] = renders.sourceDir
        else delete sources[episodeId]
        return { ...current, renderSources: sources }
      })

      await writeSidecarProject(provider, {
        ...sidecar,
        episodes: sidecar.episodes.map((e) =>
          e.id === episodeId
            ? {
                ...e,
                renders: renders
                  ? { targetSubdir: renders.targetSubdir, includeSubfolders: renders.includeSubfolders }
                  : undefined
              }
            : e
        )
      })
      return loadProject(host, root)
    }
  )

  register(IPC.checkFfmpeg, async (root: string) => {
    const sidecar = await readSidecarProject(ws(root))
    const machine = sidecar ? await host.machine.read(sidecar.id) : {}
    if ((machine.renderEncoder ?? 'builtin') !== 'ffmpeg') {
      // Whether there is a built-in encoder depends on the host: it is
      // Chromium's, so a desktop has one and a server does not. Saying yes
      // here regardless would mean finding out one failed image at a time.
      if (host.builtinEncoder) {
        return { ok: true, command: 'builtin', version: BUILT_IN_ENCODER, candidates: [] }
      }
      // Reached only if something asked anyway: the interface hides render
      // syncing where capabilities.renderSync is false, so a person is not
      // offered a feature and then told how to fix it.
      return {
        ok: false,
        candidates: [],
        error: 'Converting renders is not supported here.'
      }
    }
    return findFfmpeg(machine.ffmpegPath)
  })

  register(IPC.planRenderSync, async (root: string, episodeId: string) => {
    const sidecar = await readSidecarProject(ws(root))
    if (!sidecar) throw new Error(`No project found at ${root}`)
    const ep = sidecar.episodes.find((e) => e.id === episodeId)
    if (!ep) throw new Error('That episode is no longer in the project.')
    const machine = await host.machine.read(sidecar.id)
    const sourceDir = machine.renderSources?.[episodeId] ?? ''
    if (!ep.renders && !sourceDir) {
      return {
        sourceDir: '',
        targetDir: '',
        items: [],
        ignoredDirs: [],
        ignoredFiles: 0,
        error: 'No render folder set for this episode yet.'
      }
    }
    return planRenderSync(root, { ...ep.renders, targetSubdir: ep.renders?.targetSubdir ?? '', sourceDir })
  })

  register(
    IPC.convertRenders,
    async (root: string, episodeId: string, names: string[]) => {
      const sidecar = await readSidecarProject(ws(root))
      if (!sidecar) throw new Error(`No project found at ${root}`)
      const ep = sidecar.episodes.find((e) => e.id === episodeId)
      if (!ep) throw new Error('That episode is no longer in the project.')

      const machine = await host.machine.read(sidecar.id)
      const sourceDir = machine.renderSources?.[episodeId]
      if (!sourceDir) throw new Error('No render folder set for this episode on this machine.')

      const config = {
        ...ep.renders,
        targetSubdir: ep.renders?.targetSubdir ?? '',
        sourceDir
      }
      return convertBatch(root, config, names, {
        encoder: machine.renderEncoder ?? 'builtin',
        ffmpegPath: machine.ffmpegPath,
        quality: clampQuality(sidecar.settings.renderQuality),
        // Chromium's encoder is Electron's to supply; core knows only that a
        // host may hand it one.
        builtin: host.builtinEncoder
      })
    }
  )

  register(
    IPC.moveBeat,
    async (
      root: string,
      input: { label: string; fromEpisodeId: string; toEpisodeId: string; toIndex: number }
    ) => {
      const provider = ws(root)
      const sidecar = await readSidecarProject(provider)
      if (!sidecar) throw new Error(`No project found at ${root}`)

      const from = sidecar.episodes.find((e) => e.id === input.fromEpisodeId)
      const to = sidecar.episodes.find((e) => e.id === input.toEpisodeId)
      if (!from || !to) throw new Error('That episode is no longer in the project.')

      const fromRel = relOf(sidecar.settings, from)
      const toRel = relOf(sidecar.settings, to)
      const sameFile = fromRel === toRel

      const result = moveBeat({
        source: await provider.readText(fromRel),
        target: sameFile ? null : await provider.readText(toRel),
        label: input.label,
        toIndex: input.toIndex,
        linear: sidecar.settings.linear
      })
      if (result.error) {
        return { opened: await loadProject(host, root), error: result.error, materialised: [], warnings: [] }
      }

      await provider.writeText(fromRel, result.source)
      if (!sameFile) await provider.writeText(toRel, result.target)

      // The beat's notes belong to the beat, not the file. Move the outline
      // record too, or reconciliation would orphan it in the old episode and
      // mint a fresh, empty one in the new episode.
      if (input.fromEpisodeId !== input.toEpisodeId) {
        const outline = await readOutline(provider)
        const beat = outline.beats.find(
          (b) => b.episodeId === input.fromEpisodeId && b.label === input.label
        )
        if (beat) {
          await writeOutline(provider, {
            version: 1,
            beats: outline.beats.map((b) =>
              b.id === beat.id ? { ...b, episodeId: input.toEpisodeId } : b
            )
          })
        }
      }

      return {
        opened: await loadProject(host, root),
        materialised: result.materialised,
        warnings: result.warnings
      }
    }
  )
}
