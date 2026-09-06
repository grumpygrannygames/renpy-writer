import {
  escapeText,
  parseDocument,
  serializeDocument,
  touch,
  unescapeText,
  type ScriptNode
} from '@shared/renpy/document'
import type { CharacterNote, DiscoveredCharacter } from '@shared/types'
import { needsProofreading, needsTranslation } from './language'
import {
  buildProofreadPrompt,
  buildPrompt,
  parseResponse,
  type PassMode,
  type PassUnit
} from './prompt'
import type { PromptRunner } from './runner'

export type { PassMode } from './prompt'

export interface PassOptions {
  /** Translating into the target language, or correcting text already in it. */
  mode: PassMode
  sourceLanguage: string
  targetLanguage: string
  /** Restrict to these 1-indexed source lines; empty means the whole file. */
  lines?: number[]
  cast: DiscoveredCharacter[]
  profiles: CharacterNote[]
  /** Largest number of lines sent in one request. */
  batchSize?: number
}

export interface LineChange {
  line: number
  speaker: string | null
  before: string
  after: string
}

export interface PassResult {
  /** The rewritten file, or the original when nothing changed. */
  content: string
  changes: LineChange[]
  /** Lines the pass deliberately left alone. */
  skipped: number
  error?: string
}

/** Accent for a script variable, looked up through its profile. */
function accentFor(varName: string, profiles: CharacterNote[]): string | undefined {
  return profiles.find((p) => p.varNames.includes(varName))?.accent
}

/**
 * Run one pass over the dialogue in a script.
 *
 * Only dialogue and menu choices are touched: those are the strings a player
 * reads. Action lines are comments to the writer and stage directions, and
 * everything else is code.
 *
 * The two modes are mirror images at the gate. Translation skips what is
 * already in the target language; proofreading skips what is still in the
 * source language, since correcting a line that has not been translated yet
 * would either do nothing or quietly translate it as a side effect.
 */
export async function runPass(
  source: string,
  options: PassOptions,
  run: PromptRunner
): Promise<PassResult> {
  const doc = parseDocument(source)
  const names = new Map(options.cast.map((c) => [c.varName, c.name]))
  const only = options.lines && options.lines.length > 0 ? new Set(options.lines) : null
  const wanted = options.mode === 'translate' ? needsTranslation : needsProofreading

  const units: PassUnit[] = []
  const nodeIndex = new Map<number, number>()
  let skipped = 0

  doc.nodes.forEach((node, i) => {
    if (node.kind !== 'dialogue' && node.kind !== 'choice') return
    if (only && !only.has(i + 1)) return

    const text = unescapeText(node.text)
    if (!text.trim()) return
    if (!wanted(text)) {
      skipped++
      return
    }

    const speaker = node.kind === 'dialogue' ? node.speaker : null
    const id = units.length + 1
    nodeIndex.set(id, i)
    units.push({
      id,
      text,
      speaker: speaker ? (names.get(speaker) ?? speaker) : null,
      accent: speaker ? accentFor(speaker, options.profiles) : undefined,
      isChoice: node.kind === 'choice'
    })
  })

  if (units.length === 0) return { content: source, changes: [], skipped }

  const batchSize = options.batchSize ?? 60
  const rewritten = new Map<number, string>()

  for (let start = 0; start < units.length; start += batchSize) {
    const batch = units.slice(start, start + batchSize)
    const prompt =
      options.mode === 'translate'
        ? buildPrompt(batch, options.sourceLanguage, options.targetLanguage)
        : buildProofreadPrompt(batch, options.targetLanguage)

    const result = await run(prompt)
    if (!result.ok) return { content: source, changes: [], skipped, error: result.error }

    const parsed = parseResponse(result.output)
    if (parsed.error) return { content: source, changes: [], skipped, error: parsed.error }
    for (const [id, text] of parsed.byId) rewritten.set(id, text)
  }

  const changes: LineChange[] = []
  const nodes: ScriptNode[] = [...doc.nodes]

  for (const [id, index] of nodeIndex) {
    const next = rewritten.get(id)
    if (next === undefined) continue

    const node = nodes[index]
    if (node.kind !== 'dialogue' && node.kind !== 'choice') continue

    const before = unescapeText(node.text)
    if (next === before) continue

    nodes[index] = touch(node as never, { text: escapeText(next) } as never)
    changes.push({
      line: index + 1,
      speaker: node.kind === 'dialogue' ? node.speaker : null,
      before,
      after: next
    })
  }

  if (changes.length === 0) return { content: source, changes: [], skipped }
  return { content: serializeDocument({ ...doc, nodes }), changes, skipped }
}
