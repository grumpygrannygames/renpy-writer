import { useMemo } from 'react'
import type { CharacterNote, DiscoveredCharacter } from '@shared/types'
import { useStore } from './state/store'
import { buildLinkIndex, type RefKind, type RefTarget } from './wikiLink'

export const newId = (): string =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `id-${Date.now()}-${Math.random().toString(16).slice(2)}`

/** A profile together with the script variables it covers. */
export interface Profile {
  note: CharacterNote
  /** Resolved script definitions, in the order the profile lists them. */
  variables: DiscoveredCharacter[]
  /** Variables the profile claims that are no longer in the script. */
  missing: string[]
  /** Union of every variable's expressions. */
  expressions: string[]
  /** Colour of the first variable, used to tint the name. */
  color?: string
}

export interface CastView {
  profiles: Profile[]
  /** Script characters no profile has claimed yet. */
  unassigned: DiscoveredCharacter[]
  linkIndex: Map<string, RefTarget>
  /** Which profile owns a script variable, if any. */
  profileForVar: Map<string, Profile>
}

/**
 * Profiles are authored, never imported. The script is the source of variables
 * and their display names; a profile decides which of those variables are the
 * same person.
 */
export function useCast(): CastView {
  const scanned = useStore((s) => s.characters)
  const reference = useStore((s) => s.reference)

  return useMemo(() => {
    const byVar = new Map(scanned.map((c) => [c.varName, c]))

    const rank = new Map(reference.characterOrder.map((id, i) => [id, i]))
    const ordered = [...reference.characters].sort((a, b) => {
      const ra = rank.get(a.id)
      const rb = rank.get(b.id)
      if (ra !== undefined && rb !== undefined) return ra - rb
      // Anything without an explicit position sorts after, alphabetically.
      if (ra !== undefined) return -1
      if (rb !== undefined) return 1
      return a.name.localeCompare(b.name)
    })

    const profiles: Profile[] = ordered.map((note) => {
      const variables = note.varNames.map((v) => byVar.get(v)).filter((v): v is DiscoveredCharacter => !!v)
      const expressions = [...new Set(variables.flatMap((v) => v.expressions))].sort((a, b) =>
        a.localeCompare(b)
      )
      return {
        note,
        variables,
        missing: note.varNames.filter((v) => !byVar.has(v)),
        expressions,
        color: variables.find((v) => v.color)?.color
      }
    })

    const claimed = new Set(reference.characters.flatMap((c) => c.varNames))
    const unassigned = scanned
      .filter((c) => !claimed.has(c.varName))
      .sort((a, b) => a.name.localeCompare(b.name) || a.varName.localeCompare(b.varName))

    const profileForVar = new Map<string, Profile>()
    for (const p of profiles) for (const v of p.note.varNames) profileForVar.set(v, p)

    const linkIndex = buildLinkIndex({
      characters: profiles.map((p) => ({
        kind: 'character' as RefKind,
        id: p.note.id,
        name: p.note.name
      })),
      locations: reference.locations.map((l) => ({
        kind: 'location' as RefKind,
        id: l.id,
        name: l.name
      })),
      notes: reference.notes.map((n) => ({ kind: 'note' as RefKind, id: n.id, name: n.title }))
    })

    return { profiles, unassigned, linkIndex, profileForVar }
  }, [scanned, reference])
}
