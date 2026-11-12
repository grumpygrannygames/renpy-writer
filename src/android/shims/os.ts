import { where } from '../native'

/** `node:os`: the app's own cache folder is its temporary folder. */
export function tmpdir(): string {
  return where.cache
}

export function homedir(): string {
  return where.files
}

export const EOL = '\n'

export default { tmpdir, homedir, EOL }
