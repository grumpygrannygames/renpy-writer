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
 * The brief for the proofread pass, which is a proofreader and an editor.
 *
 * Two jobs, and the second one was missing. A proofreader fixes what is wrong.
 * An editor fixes what is merely stiff: dialogue that reads like written
 * prose, a word that turns up three lines running, a sentence that takes
 * twelve words to say six. A pass that only catches the comma errors reports
 * almost nothing on a script whose real problem is that nobody in it sounds
 * like a person -- which is exactly what comes back from translation, where
 * the grammar is perfect and the speech is not speech.
 *
 * The hard part is that restraint pulls the other way. The same model that can
 * hear stiffness will happily smooth every character into one careful voice,
 * and that is the one thing a visual novel cannot afford. So the rules name
 * what is deliberate -- dialect, profanity, broken grammar, a verbal tic --
 * and say to leave it, and the bar for touching a line at all is whether the
 * writer would plainly agree.
 */
const PROOFREAD_RULES = [
  // What is wrong.
  'Fix spelling, grammar and punctuation.',

  // What is merely stiff. This is the half a proofreader misses.
  'Make stiff lines sound spoken. Dialogue reading like written prose is the commonest fault in this kind of script: use the contractions a person would use, cut the throat-clearing at the start of a line, and prefer the short everyday word to the formal one.',
  'Cut padding. A line that says the same thing twice, or takes twelve words to say six, is tightened -- without losing anything it means.',
  'Watch for a distinctive word or phrase coming back within a few lines and vary or cut the repeat. Unless it is doing work: a verbal tic, a callback, a stammer, deliberate emphasis.',
  'The lines are consecutive and in the order they are read, so judge flow and repetition across them rather than one line at a time.',

  // What not to touch.
  'Do not change what a line means, and do not add or remove information.',
  'Do not neutralise a voice. Slang, dialect, profanity, broken grammar and odd word order are usually characterisation -- leave them, and keep each character sounding like themselves rather than like each other.',
  'Speech is not prose: fragments, interruptions and trailing off are normal in dialogue and are not errors.',
  'Keep a line about as long as it was. A dialogue box has room for a line, not a paragraph.',
  'Keep Ren’Py markup exactly as it appears: {i}, {b}, {size=+2}, {/i} and so on, wrapping the same words.',
  'Keep square-bracket interpolation such as [player_name] and percent placeholders such as %s exactly as written.',
  'Do not add or remove surrounding quotation marks.',
  'Leave a line exactly as it is unless the change is one the writer would plainly agree with. A line that reads well is a line to leave alone.',
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
    shape: '{"translations":[{"id":1,"text":"..."}]}'
  })
}

/**
 * Build the proofreading instruction. Only one language is involved: the pass
 * corrects text that is already in the language the game ships in.
 */
export function buildProofreadPrompt(units: PassUnit[], language: string): string {
  return render(units, {
    task: `Proofread and edit visual novel dialogue written in ${language}.`,
    rules: [...PROOFREAD_RULES, `If a line is not in ${language}, return it unchanged.`],
    voicesLead: 'Character voices, which must survive the pass:',
    shape: '{"revisions":[{"id":1,"text":"...","why":"..."}]}',
    // Every edit has to be answerable for. A one-word reason is what lets
    // somebody scan forty changes and see which ones they disagree with.
    shapeNote:
      'Put a short "why" on any line you changed -- a few words for what was wrong, ' +
      'such as typo, stiff, or repeats "suddenly". Leave it out of lines you return unchanged.'
  })
}

function render(
  units: PassUnit[],
  spec: {
    task: string
    rules: string[]
    voicesLead: string
    shape: string
    shapeNote?: string
  }
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

  lines.push('', 'Respond with JSON only, no commentary, in exactly this shape:', spec.shape)
  if (spec.shapeNote) lines.push(spec.shapeNote)
  lines.push('', 'Lines:')

  for (const u of units) {
    const who = u.isChoice ? 'CHOICE' : (u.speaker ?? 'NARRATOR')
    lines.push(JSON.stringify({ id: u.id, speaker: who, text: u.text }))
  }

  return lines.join('\n')
}

export interface ParsedLines {
  byId: Map<number, string>
  /** Why a line was changed, when the pass said. */
  whyById: Map<number, string>
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
  const whyById = new Map<number, string>()
  const json = extractJsonObject(raw)
  if (!json) return { byId, whyById, error: 'The pass did not return JSON.' }

  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return { byId, whyById, error: 'The pass returned malformed JSON.' }
  }

  const record = parsed as Record<string, unknown>
  const key = RESULT_KEYS.find((k) => Array.isArray(record[k]))
  if (!key) return { byId, whyById, error: 'The reply had no array of lines.' }

  for (const item of record[key] as unknown[]) {
    const id = (item as { id?: unknown }).id
    const text = (item as { text?: unknown }).text
    const why = (item as { why?: unknown }).why
    if (typeof id !== 'number' || typeof text !== 'string') continue
    byId.set(id, text)
    if (typeof why === 'string' && why.trim()) whyById.set(id, why.trim())
  }
  if (byId.size === 0) return { byId, whyById, error: 'The reply contained no usable lines.' }
  return { byId, whyById }
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
