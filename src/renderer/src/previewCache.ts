import type { ImageLookup } from './imageHover'

/**
 * Pictures already fetched, so they are not fetched again.
 *
 * Both are data URLs, which are expensive to produce and to send across the
 * bridge, and both were kept for the life of the session. That is right until
 * the file behind one changes: a portrait redrawn in another program, or a
 * folder of renders converted into the game by this one. The picture on screen
 * then stays as it was, and no amount of clicking brings the new one in.
 *
 * So they are held here, together, where one call can forget the lot.
 */
export const portraits = new Map<string, string | null>()
export const images = new Map<string, ImageLookup | null>()

export function forgetPreviews(): void {
  portraits.clear()
  images.clear()
}
