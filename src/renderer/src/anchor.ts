/**
 * Which block sits at the vertical middle of a scrolled list.
 *
 * Kept as a pure function so it can be tested directly: scroll events are not
 * dispatched at all in a hidden or offscreen Chromium window, which makes this
 * impossible to exercise through the UI in an automated run.
 */
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
