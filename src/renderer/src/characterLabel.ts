import type { DiscoveredCharacter } from '@shared/types'

/** "Other Alice" -> "other_alice" */
function slug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
}

export interface CharacterLabel {
  /** What to show as the screenplay character cue. */
  name: string
  /**
   * Variant marker, or null when the variable name adds nothing.
   *
   * Several Ren'Py characters share one display name -- david and
   * david_thoughts are both "David" -- and they compile to different lines, so
   * the writer has to tell them apart. But a short variable for a long name
   * (bacchus for "Charles Bacchus") is not a variant and must stay unmarked,
   * or nearly every line grows a meaningless badge.
   */
  variant: string | null
}

export type Labeller = (
  speaker: string,
  character: DiscoveredCharacter | undefined
) => CharacterLabel

/**
 * Build a labeller for one project's cast.
 *
 * A marker is shown when the variable extends the display name
 * (david -> david_thoughts gives "thoughts", jeff -> jeff_msg gives "msg"), or
 * when two characters would otherwise render identically, in which case the
 * variable name itself disambiguates them.
 */
export function buildLabeller(characters: DiscoveredCharacter[]): Labeller {
  // Characters that would render as the same cue, grouped by display name.
  const groups = new Map<string, string[]>()
  for (const c of characters) {
    const key = c.name.toUpperCase()
    const list = groups.get(key)
    if (list) list.push(c.varName)
    else groups.set(key, [c.varName])
  }

  /** The shortest variable in a colliding group is the plain form. */
  const groupBase = new Map<string, string>()
  for (const [key, vars] of groups) {
    if (vars.length > 1) {
      groupBase.set(key, [...vars].sort((a, b) => a.length - b.length)[0])
    }
  }

  return (speaker, character) => {
    if (!character) return { name: speaker.toUpperCase(), variant: null }

    const name = character.name.toUpperCase()
    const varName = character.varName
    const suffix = (base: string): string | null =>
      varName === base
        ? null
        : varName.startsWith(base + '_')
          ? varName.slice(base.length + 1).replace(/_/g, ' ')
          : undefined!

    // Preferred: the variable extends the display name (jeff -> jeff_msg).
    const fromName = suffix(slug(character.name))
    if (fromName !== undefined) return { name, variant: fromName }

    // Otherwise fall back to the group's plain form, which is what separates
    // bacchus from bacchus_thoughts when neither matches "Charles Bacchus".
    const base = groupBase.get(name)
    if (base) {
      const fromGroup = suffix(base)
      return { name, variant: fromGroup === undefined ? varName : fromGroup }
    }

    // A unique character whose variable is just a short form of its name.
    return { name, variant: null }
  }
}
