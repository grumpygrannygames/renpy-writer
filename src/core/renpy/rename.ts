import type { WorkspaceProvider } from '../workspace/WorkspaceProvider'

export interface RenameResult {
  ok: boolean
  /** Why the rename was refused, when ok is false. */
  reason?: string
  /** The line as it now reads, for confirmation in the UI. */
  line?: string
}

/**
 * The display name inside `define x = Character('Name', ...)`.
 *
 * Only the first quoted argument is touched, and only on the one line the
 * scanner recorded. Everything else on that line -- colour, image tag,
 * callbacks, kwargs -- is left exactly as written.
 */
const DEFINE_RE =
  /^(\s*define\s+([A-Za-z_]\w*)\s*=\s*Character\s*\(\s*(?:_\(\s*)?)(["'])((?:[^"'\\]|\\.)*)\3/

/** Ren'Py string escaping for the display name. */
function escapeFor(quote: string, value: string): string {
  return value.replace(/\\/g, '\\\\').replace(new RegExp(quote, 'g'), '\\' + quote)
}

/**
 * Rewrite a character's display name in the script.
 *
 * This is the one place the app edits a file the writer did not open, so it is
 * intentionally conservative: it verifies the line still defines the character
 * it was told about, and rewrites nothing if anything looks different.
 */
export async function renameCharacter(
  ws: WorkspaceProvider,
  relFile: string,
  lineNumber: number,
  varName: string,
  newName: string
): Promise<RenameResult> {
  const trimmed = newName.trim()
  if (!trimmed) return { ok: false, reason: 'A character needs a name.' }
  if (/[\r\n]/.test(trimmed)) return { ok: false, reason: 'A name cannot span lines.' }
  if (!(await ws.exists(relFile))) return { ok: false, reason: `${relFile} no longer exists.` }

  const source = await ws.readText(relFile)
  const bom = source.startsWith('﻿') ? '﻿' : ''
  const body = bom ? source.slice(1) : source

  // Keep each line's own terminator so the file round-trips exactly.
  const parts = body.split(/(\r\n|\n|\r)/)
  const lineIndex = (lineNumber - 1) * 2
  if (lineIndex < 0 || lineIndex >= parts.length) {
    return { ok: false, reason: `Line ${lineNumber} is outside ${relFile}.` }
  }

  const line = parts[lineIndex]
  const m = line.match(DEFINE_RE)
  if (!m) {
    return { ok: false, reason: `Line ${lineNumber} of ${relFile} no longer defines a character.` }
  }
  if (m[2] !== varName) {
    return {
      ok: false,
      reason: `Line ${lineNumber} of ${relFile} defines ${m[2]}, not ${varName}. Reopen the project to rescan.`
    }
  }

  const quote = m[3]
  const rewritten = m[1] + quote + escapeFor(quote, trimmed) + quote + line.slice(m[0].length)
  if (rewritten === line) return { ok: true, line }

  parts[lineIndex] = rewritten
  await ws.writeText(relFile, bom + parts.join(''))
  return { ok: true, line: rewritten }
}
