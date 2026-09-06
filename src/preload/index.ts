import { contextBridge, ipcRenderer } from 'electron'
import type {
  CreateEpisodeInput,
  CreateProjectInput,
  MoveBeatRequest,
  CommitRequest,
  Decision,
  ScriptPassRequest,
  RenpyWriterApi
} from '@shared/api'
import { IPC } from '@shared/api'
import type { EpisodeStatus, ProjectSettings, Reference, RenderConfig } from '@shared/types'

const api: RenpyWriterApi = {
  listProjects: () => ipcRenderer.invoke(IPC.listProjects),
  pickFolder: () => ipcRenderer.invoke(IPC.pickFolder),
  checkRoot: (root: string) => ipcRenderer.invoke(IPC.checkRoot, root),
  createProject: (input: CreateProjectInput) => ipcRenderer.invoke(IPC.createProject, input),
  openProject: (root: string) => ipcRenderer.invoke(IPC.openProject, root),
  removeProject: (id: string) => ipcRenderer.invoke(IPC.removeProject, id),
  updateSettings: (root: string, settings: ProjectSettings) =>
    ipcRenderer.invoke(IPC.updateSettings, root, settings),
  scanCharacters: (root: string) => ipcRenderer.invoke(IPC.scanCharacters, root),
  readPortrait: (root: string, rel: string) => ipcRenderer.invoke(IPC.readPortrait, root, rel),
  renameCharacter: (root: string, varName: string, newName: string) =>
    ipcRenderer.invoke(IPC.renameCharacter, root, varName, newName),
  resolveImage: (root: string, name: string) => ipcRenderer.invoke(IPC.resolveImage, root, name),
  readReference: (root: string) => ipcRenderer.invoke(IPC.readReference, root),
  writeReference: (root: string, reference: Reference) =>
    ipcRenderer.invoke(IPC.writeReference, root, reference),
  createEpisode: (input: CreateEpisodeInput) => ipcRenderer.invoke(IPC.createEpisode, input),
  reorderEpisodes: (root: string, ids: string[]) =>
    ipcRenderer.invoke(IPC.reorderEpisodes, root, ids),
  setEpisodeStatus: (root: string, episodeId: string, status: EpisodeStatus) =>
    ipcRenderer.invoke(IPC.setEpisodeStatus, root, episodeId, status),
  moveBeat: (root: string, input: MoveBeatRequest) =>
    ipcRenderer.invoke(IPC.moveBeat, root, input),
  runScriptPass: (root: string, input: ScriptPassRequest) =>
    ipcRenderer.invoke(IPC.runScriptPass, root, input),
  capabilities: () => ipcRenderer.invoke(IPC.capabilities),
  gitStatus: (root: string) => ipcRenderer.invoke(IPC.gitStatus, root),
  gitPull: (root: string) => ipcRenderer.invoke(IPC.gitPull, root),
  gitCommit: (root: string, input: CommitRequest) =>
    ipcRenderer.invoke(IPC.gitCommit, root, input),
  gitFetchStatus: (root: string) => ipcRenderer.invoke(IPC.gitFetchStatus, root),
  gitPush: (root: string) => ipcRenderer.invoke(IPC.gitPush, root),
  gitResolvePull: (root: string, decisions: Decision[]) =>
    ipcRenderer.invoke(IPC.gitResolvePull, root, decisions),
  setEpisodeRenders: (root: string, episodeId: string, renders: RenderConfig | null) =>
    ipcRenderer.invoke(IPC.setEpisodeRenders, root, episodeId, renders),
  checkFfmpeg: (root: string) => ipcRenderer.invoke(IPC.checkFfmpeg, root),
  planRenderSync: (root: string, episodeId: string) =>
    ipcRenderer.invoke(IPC.planRenderSync, root, episodeId),
  convertRenders: (root: string, episodeId: string, names: string[]) =>
    ipcRenderer.invoke(IPC.convertRenders, root, episodeId, names),
  parseEpisode: (root: string, fileName: string) =>
    ipcRenderer.invoke(IPC.parseEpisode, root, fileName),
  readEpisode: (root: string, fileName: string) =>
    ipcRenderer.invoke(IPC.readEpisode, root, fileName),
  writeEpisode: (root: string, fileName: string, content: string) =>
    ipcRenderer.invoke(IPC.writeEpisode, root, fileName, content)
}

contextBridge.exposeInMainWorld('api', api)
