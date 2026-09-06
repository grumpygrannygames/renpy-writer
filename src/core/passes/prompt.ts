/** Which pass is being run over the dialogue. */
export type PassMode = 'translate' | 'proofread'

export interface PassUnit {
  /** Index into the document's node list, so the result can be applied back. */
  id: number
  /** Text to work on, already unescaped for reading. */
  text: string
  /** Display name of the speaker, or null for a narrator line or a choice. */
  speaker: string | null
  /** The speaker's accent, slang or dialect from their profile. */
  accent?: string
  /** True for a menu choice, which is a button label rather than speech. */
  isChoice?: boolean
}

/** @deprecated Kept as the old name while call sites settle. */
export type TranslationUnit = PassUnit

const TRANSLATE_RULES = [
  'Return natural spoken dialogue, not a literal gloss. It will be read aloud in a visual novel.',
  'Keep Ren’Py markup exactly as it appears: {i}, {b}, {size=+2}, {/i} and so on, wrapping the same words.',
  'Keep square-bracket interpolation such as [player_name] and percent placeholders such as %s exactly as written.',
  'Do not add or remove surrounding quotation marks.',
  'Keep the speaker’s register: profanity stays profanity, and a clipped line stays clipped.',
  'If a line is already in the target language, return it unchanged.',
  'Never merge, split or reorder lines. Every id in must appear exactly once in the output.'
]

/**
 * The proofreading brief.
 *
 * The hard part is restraint. This runs over dialogue that has usually just
 * come out of the translation pass, where the temptation is to smooth every
 * line into the same neutral voice — which is exactly what a visual novel
 * cannot afford. So the rules spend most of their words on what not to touch.
 */
const PROOFREAD_RULES = [
  'Fix spelling, grammar, punctuation and genuinely awkward phrasing. Nothing else.',
  'Do not change what a line means, and do not add or remove information.',
  'Do not neutralise a voice. Slang, dialect, profanity, broken grammar and odd word order are usually deliberate characterisation — leave them alone unless they read as a mistake rather than a choice.',
  'Speech is not prose: fragments, interruptions, trailing off and repetition are normal in dialogue and are not errors.',
  'Keep Ren’Py markup exactly as it appears: {i}, {b}, {size=+2}, {/i} and so on, wrapping the same words.',
  'Keep square-bracket interpolation such as [player_name] and percent placeholders such as %s exactly as written.',
  'Do not add or remove surrounding quotation marks.',
  'Return a line completely unchanged unless it is actually wrong. Most lines should come back untouched.',
  'Never merge, split or reorder lines. Every id in must appear exactly once in the output.'
]

/**
 * Build the instruction for a pass.
 *
 * Lines go over with their speaker and that character's accent, because the
 * same sentence should read differently depending on who says it — and for
 * proofreading the accent is what stops a character's voice being corrected
 * out of existence. Ids are carried through so results can be matched back to
 * exact script lines rather than by position.
 */
export function buildPrompt(
  units: PassUnit[],
  sourceLanguage: string,
  targetLanguage: string
): string {
  return render(units, {
    task: `Translate visual novel dialogue from ${sourceLanguage} to ${targetLanguage}.`,
    rules: TRANSLATE_RULES,
    voicesLead: 'Character voices:',
    responseKey: 'translations'
  })
}

/**
 * Build the proofreading instruction. Only one language is involved: the pass
 * corrects text that is already in the language the game ships in.
 */
export function buildProofreadPrompt(units: PassUnit[], language: string): string {
  return render(units, {
    task: `Proofread visual novel dialogue written in ${language}.`,
    rules: [...PROOFREAD_RULES, `If a line is not in ${language}, return it unchanged.`],
    voicesLead: 'Character voices, which must survive the pass:',
    responseKey: 'revisions'
  })
}

function render(
  units: PassUnit[],
  spec: { task: string; rules: string[]; voicesLead: string; responseKey: string }
): string {
  const accents = new Map<string, string>()
  for (const u of units) {
    if (u.speaker && u.accent) accents.set(u.speaker, u.accent)
  }

  const lines: string[] = []
  lines.push(spec.task, '', 'Rules:')
  spec.rules.forEach((r) => lines.push(`- ${r}`))

  if (accents.size > 0) {
    lines.push('', spec.voicesLead)
    for (const [name, accent] of accents) lines.push(`- ${name}: ${accent}`)
  }

  lines.push(
    '',
    'Respond with JSON only, no commentary, in exactly this shape:',
    `{"${spec.responseKey}":[{"id":1,"text":"..."}]}`,
    '',
    'Lines:'
  )

  for (const u of units) {
    const who = u.isChoice ? 'CHOICE' : (u.speaker ?? 'NARRATOR')
    lines.push(JSON.stringify({ id: u.id, speaker: who, text: u.text }))
  }

  return lines.join('\n')
}

export interface ParsedLines {
  byId: Map<number, string>
  error?: string
}

/** Keys a reply may carry its array under, so both passes share one parser. */
const RESULT_KEYS = ['translations', 'revisions', 'lines']

/**
 * Pull the rewritten lines out of the reply.
 *
 * The reply may carry a prose preamble or a code fence, so the first balanced
 * JSON object is extracted rather than assuming the whole body is JSON.
 */
export function parseResponse(raw: string): ParsedLines {
  const byId = new Map<number, string>()
  const json = extractJsonObject(raw)
  if (!json) return { byId, error: 'The pass did not return JSON.' }

  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return { byId, error: 'The pass returned malformed JSON.' }
  }

  const record = parsed as Record<string, unknown>
  const key = RESULT_KEYS.find((k) => Array.isArray(record[k]))
  if (!key) return { byId, error: 'The reply had no array of lines.' }

  for (const item of record[key] as unknown[]) {
    const id = (item as { id?: unknown }).id
    const text = (item as { text?: unknown }).text
    if (typeof id === 'number' && typeof text === 'string') byId.set(id, text)
  }
  if (byId.size === 0) return { byId, error: 'The reply contained no usable lines.' }
  return { byId }
}

/** First balanced {...} run, ignoring braces inside strings. */
function extractJsonObject(text: string): string | null {
  const start = text.indexOf('{')
  if (start === -1) return null

  let depth = 0
  let inString = false
  let escaped = false

  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return text.slice(start, i + 1)
    }
  }
  return null
}
