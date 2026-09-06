import { readMachineProject, updateMachineProject } from '@core/machine'
import type { HostServices } from '@core/handlers'

/**
 * Settings that belong to the installation rather than the project.
 *
 * On a server "this machine" is the server itself, so the same file-backed
 * store the desktop uses is correct: there is no Blender folder here and no
 * local ffmpeg to name, which is exactly what an empty store says.
 */
export function createMachineStore(): HostServices['machine'] {
  return { read: readMachineProject, update: updateMachineProject }
}
