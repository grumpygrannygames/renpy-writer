/**
 * Where one line leaves the indentation for the next.
 *
 * Ren'Py takes its structure from indentation, the way Python does: a
 * statement ending in a colon opens a block, and what belongs to that block is
 * indented past it. `label start:`, `menu:`, `if flag:`, `else:`, `python:`
 * and a menu choice -- `"Push":` -- are all that same shape.
 */

/**
 * The line with any comment taken off the end.
 *
 * A `#` inside a string is not a comment: `ben "call #5:"` is a line of
 * dialogue, and cutting at the first hash would leave it looking like a
 * statement that opens a block. So this walks the quotes instead.
 */
export function stripComment(line: string): string {
  let quote: string | null = null
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (quote) {
      // Ren'Py escapes a quote inside a string the way Python does.
      if (c === '\\') i++
      else if (c === quote) quote = null
    } else if (c === '"' || c === "'") {
      quote = c
    } else if (c === '#') {
      return line.slice(0, i)
    }
  }
  return line
}

/**
 * Does a line after this one belong inside it?
 *
 * The colon rather than a list of keywords. The keywords are not a closed set
 * -- `label`, `menu`, `if`, `else`, `while`, `python`, `init`, `screen`,
 * `style`, `transform`, `layeredimage`, a menu choice, and more with every
 * Ren'Py release -- so a list of them is a list that falls behind. What every
 * one of them has in common is the colon, and nothing else in a script ends
 * with one: dialogue ends with a quote, and a comment is not code.
 */
export function opensBlock(line: string): boolean {
  return stripComment(line).trimEnd().endsWith(':')
}
