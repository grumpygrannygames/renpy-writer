/**
 * Turning a person's name into the variable the script will call them by.
 *
 * Shared rather than kept in the core because the dialog shows the writer the
 * exact line before it is written, and a preview that disagrees with what
 * lands in the file would be worse than no preview at all.
 */

/**
 * Reserved in Python, and so unusable as a variable however good a name it is.
 * A character called Class would otherwise produce a script that will not
 * load, with an error pointing at a line nobody typed.
 */
const KEYWORDS = new Set([
  'False', 'None', 'True', 'and', 'as', 'assert', 'async', 'await', 'break',
  'class', 'continue', 'def', 'del', 'elif', 'else', 'except', 'finally',
  'for', 'from', 'global', 'if', 'import', 'in', 'is', 'lambda', 'nonlocal',
  'not', 'or', 'pass', 'raise', 'return', 'try', 'while', 'with', 'yield'
])

/** Whether Python would refuse this as a variable name. */
export function isReservedName(name: string): boolean {
  return KEYWORDS.has(name)
}

/** Whether this could be a Ren'Py variable at all. */
export function isVarName(name: string): boolean {
  return /^[A-Za-z_]\w*$/.test(name) && !KEYWORDS.has(name)
}

/**
 * "Mara Kowalski" -> "mara_kowalski", "Åsa" -> "asa".
 *
 * Accents are folded rather than dropped, so a Swedish or Czech name still
 * arrives as itself. Names in a script with no Latin letters at all -- 藍, say
 * -- have nothing to fold to; those fall back to `character`, which the writer
 * can change in the file. Ren'Py 7 is Python 2 underneath, where a variable
 * outside ASCII is a syntax error, and a name that cannot be typed on the
 * keyboard the script is written with is no kindness either.
 */
export function toVarName(name: string): string {
  const folded = name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/['\u2019]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')

  if (!folded) return 'character'
  if (/^[0-9]/.test(folded)) return `c_${folded}`
  return KEYWORDS.has(folded) ? `${folded}_` : folded
}

/**
 * A name nothing else is using, numbered only as far as it has to be.
 *
 * Counting continues from a number the name already ends with rather than
 * starting again after it: a second MORNING_2 is MORNING_3, not MORNING_2_2,
 * which is what you get by appending without looking. A few rounds of that and
 * the name is mostly underscores and twos.
 *
 * `taken` decides what counts as used, so a caller comparing labels can ignore
 * case while one comparing variables need not.
 */
export function freeName(wanted: string, taken: (name: string) => boolean): string {
  if (!taken(wanted)) return wanted
  // A trailing number is a count somebody (or this) already added to it.
  const numbered = wanted.match(/^(.+)_(\d+)$/)
  const base = numbered ? numbered[1] : wanted
  let n = numbered ? Number(numbered[2]) + 1 : 2
  for (;;) {
    const candidate = `${base}_${n}`
    if (!taken(candidate)) return candidate
    n++
  }
}

/**
 * The same, made unique against what the project already defines.
 *
 * Ren'Py refuses to load a file that defines the same name twice, so a second
 * Mara has to become mara_2 rather than quietly replacing the first.
 */
export function characterVarName(name: string, taken: Iterable<string>): string {
  const used = new Set(taken)
  return freeName(toVarName(name), (candidate) => used.has(candidate))
}

/** Ren'Py string escaping for a display name written inside double quotes. */
export function quoteName(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

/** The line a definition is written as. */
export function defineLine(varName: string, displayName: string): string {
  return `define ${varName} = Character("${quoteName(displayName)}")`
}
