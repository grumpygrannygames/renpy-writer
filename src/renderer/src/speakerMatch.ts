import type { DiscoveredCharacter } from '@shared/types'

/** Characters in a regular expression that have to be taken literally. */
function literal(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * How well a character answers what has been typed, or null if they do not.
 * Lower is better.
 *
 * Typing the beginning of a name is the common case and stays first. But a
 * cast is full of people whose script name starts with something you would not
 * think to type -- Detective Cook is `cook` to the writer and `detective_cook`
 * to the script -- so a later word counts too, and then anywhere at all.
 */
export function speakerRank(
  character: { varName: string; name: string },
  query: string
): number | null {
  const q = query.trim().toLowerCase()
  if (!q) return null
  const varName = character.varName.toLowerCase()
  const name = character.name.toLowerCase()

  if (varName.startsWith(q)) return 0
  if (name.startsWith(q)) return 1
  // The start of any later word: "cook" in "Detective Cook", or in
  // `detective_cook`, which is the same person said twice.
  const word = new RegExp(`[\\s_.-]${literal(q)}`)
  if (word.test(name) || word.test(varName)) return 2
  if (name.includes(q) || varName.includes(q)) return 3
  return null
}

/**
 * The cast that answers what has been typed, best first.
 *
 * Where two answer equally well the shorter name goes first: somebody typing
 * `de` and meaning `detective_cook` has more to type either way, while
 * somebody meaning `dev` has finished. Names of the same length are ordered
 * alphabetically, so the list never reshuffles itself for reasons the writer
 * cannot see.
 */
export function matchSpeakers(
  characters: readonly DiscoveredCharacter[],
  query: string,
  limit = 8
): DiscoveredCharacter[] {
  const ranked: Array<{ character: DiscoveredCharacter; rank: number }> = []
  for (const character of characters) {
    const rank = speakerRank(character, query)
    if (rank !== null) ranked.push({ character, rank })
  }
  ranked.sort(
    (a, b) =>
      a.rank - b.rank ||
      a.character.varName.length - b.character.varName.length ||
      a.character.varName.localeCompare(b.character.varName)
  )
  return ranked.slice(0, limit).map((r) => r.character)
}
