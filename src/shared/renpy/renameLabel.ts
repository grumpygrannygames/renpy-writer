/**
 * Renaming a label inside a piece of text: the `label` that declares it and
 * the `jump` and `call` that reach it.
 *
 * Shared rather than kept in the core, because the writer view renames scenes
 * in the document it has open, and a jump into a scene has to follow the
 * scene there exactly as it does when the outline renames one.
 */

/**
 * `label X:`, keeping any parameters and any trailing comment.
 *
 * The word boundary is what stops renaming `CH2_YARD` from touching
 * `CH2_YARD_NIGHT`, which is the mistake a plain search and replace makes.
 */
const DEFINITION = (label: string): RegExp => new RegExp(`^(\\s*label\\s+)${label}(\\b[\\s\\S]*)$`)
/** `jump X`, `call X`, and `call X from Y`. */
const REFERENCE = (label: string): RegExp =>
  new RegExp(`^(\\s*(?:jump|call)\\s+)${label}(\\b.*)$`)

/** Rewrite one file's text. Returns the same string when nothing matched. */
export function renameLabelIn(
  text: string,
  oldLabel: string,
  newLabel: string
): { text: string; lines: number } {
  const definition = DEFINITION(oldLabel)
  const reference = REFERENCE(oldLabel)
  const parts = text.split(/(\r\n|\n|\r)/)
  let lines = 0

  for (let i = 0; i < parts.length; i += 2) {
    const line = parts[i]
    if (!line || !line.includes(oldLabel)) continue
    if (definition.test(line)) {
      parts[i] = line.replace(definition, `$1${newLabel}$2`)
      lines++
      continue
    }
    if (reference.test(line)) {
      parts[i] = line.replace(reference, `$1${newLabel}$2`)
      lines++
    }
  }

  return { text: lines > 0 ? parts.join('') : text, lines }
}
