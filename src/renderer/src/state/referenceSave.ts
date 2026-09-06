/**
 * Whether a reference write that was scheduled a moment ago should still go
 * ahead.
 *
 * The reference files -- characters, locations, notes -- save on a debounce,
 * so the write happens over a second after the edit that caused it. In that
 * second the project can be closed, another opened, or the same one reopened
 * and still loading. A write that goes ahead regardless carries whatever
 * happens to be in memory into whatever happens to be open.
 *
 * That is not a hypothetical. It emptied the character profiles of a real
 * project: the file went from two people with names and ages to
 * `"characters": []`, with nothing on screen to say so, because the write
 * landed while the newly opened project's reference had not finished loading.
 *
 * Three things have to agree, and it is worth being explicit about why each
 * one matters:
 *
 *   - Something is open. Otherwise there is nowhere to write.
 *   - What is open now is what was open when the write was scheduled.
 *     Otherwise one project's notes land in another.
 *   - The reference in hand was read from that same project. Otherwise an
 *     empty placeholder, or the previous project's data, is written over a
 *     real file.
 */
export function shouldWriteReference(
  /** The project open when the write was scheduled. */
  scheduledFor: string | null,
  /** The project open now, as the write is about to happen. */
  openNow: string | null,
  /** The project the reference currently in memory was read from. */
  loadedFrom: string | null
): boolean {
  if (openNow === null) return false
  return openNow === scheduledFor && loadedFrom === openNow
}
