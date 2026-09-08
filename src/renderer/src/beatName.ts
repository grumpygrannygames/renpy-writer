/**
 * A beat's name as it should be read.
 *
 * Titles come from Ren'Py labels, which are written for the engine:
 * `D14_MORNING`. The underscores are punctuation the engine needs and a
 * person does not, so they are spaces here and the label itself is untouched.
 */
export function beatName(title: string): string {
  return title.replace(/_/g, ' ').toUpperCase()
}
