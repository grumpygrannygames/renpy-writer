/**
 * Patterns shared by the character scanner.
 *
 * `define alice = Character('Alice', color="#ffffb2", image="alice")`
 *
 * The name is matched as a proper quoted string with escapes, so a renamed
 * character like `O\'Hara` still reads back correctly.
 */
export const CHARACTER_RE =
  /^\s*define\s+([A-Za-z_]\w*)\s*=\s*Character\s*\(\s*(?:_\(\s*)?(["'])((?:[^\\]|\\.)*?)\2/

export const COLOR_RE = /color\s*=\s*["'](#[0-9a-fA-F]{3,8})["']/
export const IMAGE_ATTR_RE = /image\s*=\s*["']([A-Za-z_]\w*)["']/

/** `image side alice happy = "portraits/alice_happy.png"` */
export const SIDE_IMAGE_RE =
  /^\s*image\s+side\s+([A-Za-z_]\w*)((?:\s+[A-Za-z_]\w*)*)\s*=\s*["']([^"']+)["']/

/** Undo Ren'Py string escaping in a display name: `O\'Hara` -> `O'Hara`. */
export function unescapeName(raw: string): string {
  return raw.replace(/\\(.)/g, '$1')
}
