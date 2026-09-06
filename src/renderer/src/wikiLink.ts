export type RefKind = 'character' | 'location' | 'note'

export interface RefTarget {
  kind: RefKind
  id: string
  name: string
}

export type LinkSegment =
  | { kind: 'text'; text: string }
  | { kind: 'link'; text: string; target: RefTarget | null }

const LINK_RE = /\[\[([^\][]+)\]\]/g

/**
 * Split text into plain runs and [[wiki links]].
 *
 * A link that matches nothing still renders, marked as unresolved, so writing
 * `[[Barnabas]]` before that character exists is a normal thing to do rather
 * than an error.
 */
export function parseLinks(text: string, index: Map<string, RefTarget>): LinkSegment[] {
  const out: LinkSegment[] = []
  let last = 0
  LINK_RE.lastIndex = 0

  let m: RegExpExecArray | null
  while ((m = LINK_RE.exec(text)) !== null) {
    if (m.index > last) out.push({ kind: 'text', text: text.slice(last, m.index) })
    const label = m[1].trim()
    out.push({ kind: 'link', text: label, target: index.get(label.toLowerCase()) ?? null })
    last = LINK_RE.lastIndex
  }
  if (last < text.length) out.push({ kind: 'text', text: text.slice(last) })
  return out
}

/**
 * Build the lookup used to resolve links. Later entries do not overwrite
 * earlier ones, so characters win over locations and notes when names collide.
 */
export function buildLinkIndex(groups: {
  characters: RefTarget[]
  locations: RefTarget[]
  notes: RefTarget[]
}): Map<string, RefTarget> {
  const index = new Map<string, RefTarget>()
  for (const target of [...groups.characters, ...groups.locations, ...groups.notes]) {
    const key = target.name.trim().toLowerCase()
    if (key && !index.has(key)) index.set(key, target)
  }
  return index
}

/** Names referenced by a body of text, whether or not they resolve. */
export function linkedNames(text: string): string[] {
  const names: string[] = []
  LINK_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = LINK_RE.exec(text)) !== null) names.push(m[1].trim())
  return names
}
