/**
 * Which block sits at the vertical middle of a scrolled list.
 *
 * Kept as a pure function so it can be tested directly: scroll events are not
 * dispatched at all in a hidden or offscreen Chromium window, which makes this
 * impossible to exercise through the UI in an automated run.
 */
/**
 * The nearest line that is actually on screen in the writer.
 *
 * The writer draws dialogue and headings; `scene`, `show`, `if` and the rest
 * are code, and code is hidden there. So the line the code view was looking at
 * very often does not exist in the writer at all -- and asking to scroll to a
 * line that is not drawn scrolls nowhere, which is how switching views landed
 * back at the top of the file.
 *
 * The line above is the right answer rather than the one below: a `scene`
 * belongs to the exchange it opens, and a reader looking at it is reading from
 * there downwards.
 */
export function nearestLine(lines: readonly number[], want: number): number | null {
  let best: number | null = null
  for (const line of lines) {
    if (line <= want) best = line
    // Ascending, so the first line past the mark settles it either way.
    else return best ?? line
  }
  return best
}

export function centreIndex(offsetTops: readonly number[], middle: number): number {
  let lo = 0
  let hi = offsetTops.length - 1
  let best = -1
  // Blocks are in document order, so offsetTop increases monotonically and the
  // answer is the last one starting at or above the midpoint. Taking the last
  // one rather than a containing block matters because margins leave gaps that
  // no element covers.
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (offsetTops[mid] <= middle) {
      best = mid
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  return best
}
