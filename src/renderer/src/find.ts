/**
 * Finding words, kept apart from the two views that do the finding.
 *
 * The writer searches a list of blocks and the code view searches one long
 * string, but "where does this appear, and which one am I on" is the same
 * question in both, and it is the part worth testing without a browser.
 */

/**
 * Every place `query` occurs in `text`, ignoring case.
 *
 * Overlapping occurrences all count: "aa" is in "aaa" twice, and a reader
 * stepping through matches would be right to expect both.
 */
export function offsetsIn(text: string, query: string): number[] {
  const needle = query.toLowerCase()
  if (!needle) return []
  const hay = text.toLowerCase()
  const out: number[] = []
  let at = hay.indexOf(needle)
  while (at !== -1) {
    out.push(at)
    at = hay.indexOf(needle, at + 1)
  }
  return out
}

/** Which of these texts contain the query, in the order they were given. */
export function matchingIndexes(texts: readonly string[], query: string): number[] {
  const needle = query.trim().toLowerCase()
  if (!needle) return []
  const out: number[] = []
  texts.forEach((text, i) => {
    if (text.toLowerCase().includes(needle)) out.push(i)
  })
  return out
}

/**
 * Move through the matches, wrapping round at either end.
 *
 * Wrapping rather than stopping: the last match is not the end of the search,
 * it is the end of the file, and a reader who keeps pressing Enter means keep
 * going.
 */
export function step(current: number, total: number, delta: number): number {
  if (total <= 0) return -1
  return (((current + delta) % total) + total) % total
}
