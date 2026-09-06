import { parseEpisode } from './labels'
import type { LabelSpan } from '@shared/types'

const BOM = '﻿'

interface Doc {
  bom: string
  /** Each entry keeps its own terminator, so the file round-trips exactly. */
  lines: string[]
  eols: string[]
}

function split(text: string): Doc {
  const bom = text.startsWith(BOM) ? BOM : ''
  const body = bom ? text.slice(1) : text
  const lines: string[] = []
  const eols: string[] = []
  const re = /([^\r\n]*)(\r\n|\n|\r|$)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(body)) !== null) {
    lines.push(m[1])
    eols.push(m[2])
    if (m[2] === '' || re.lastIndex >= body.length) break
  }
  if (lines.length > 1 && lines[lines.length - 1] === '' && eols[eols.length - 1] === '') {
    lines.pop()
    eols.pop()
  }
  return { bom, lines, eols }
}

function join(doc: Doc): string {
  return doc.bom + doc.lines.map((l, i) => l + doc.eols[i]).join('')
}

/** The dominant line terminator, so inserted lines match the file. */
function nativeEol(doc: Doc): string {
  return doc.eols.find((e) => e !== '') ?? '\n'
}

/** Indentation used inside a label body, defaulting to four spaces. */
function bodyIndent(doc: Doc, span: LabelSpan): string {
  for (let i = span.startLine; i < span.endLine; i++) {
    const line = doc.lines[i]
    if (!line || line.trim() === '') continue
    const m = line.match(/^[ \t]+/)
    if (m) return m[0]
  }
  return '    '
}

/**
 * Turn an implicit fall-through into an explicit `jump`.
 *
 * A label with no terminator runs into whatever follows it in file order. That
 * is an invisible dependency on layout, so before any move that would change
 * what follows, the intent is written down.
 */
function materialize(doc: Doc, span: LabelSpan, target: string): void {
  if (span.endKind !== 'fallthrough' || !target) return
  const indent = bodyIndent(doc, span)
  // endLine is 1-indexed and inclusive, so this inserts straight after it.
  doc.lines.splice(span.endLine, 0, `${indent}jump ${target}`)
  doc.eols.splice(span.endLine, 0, nativeEol(doc))
}

/** Re-read spans after the line array has changed. */
function spansOf(doc: Doc): LabelSpan[] {
  return parseEpisode('memory', join(doc)).labels
}

/**
 * Point every label at the next one in file order.
 *
 * Only a bare trailing `jump` is rewritten, and the last label is left alone;
 * a label ending in a menu, return or if block is hand-authored and never
 * touched, whatever the project setting says.
 */
function relinkLinear(text: string): { text: string; warnings: string[] } {
  const doc = split(text)
  const warnings: string[] = []
  for (;;) {
    const spans = spansOf(doc)
    let changed = false

    for (let i = 0; i < spans.length - 1; i++) {
      const span = spans[i]
      const next = spans[i + 1].label
      if (span.endKind === 'hand-authored') {
        // A menu, return or if block is the writer's own control flow. Linear
        // ordering cannot express itself here, so say so instead of guessing.
        const note = `${span.label} ends in its own control flow, so it was not pointed at ${next}.`
        if (!warnings.includes(note)) warnings.push(note)
        continue
      }

      if (span.endKind === 'jump') {
        if (span.trailingJump === next) continue
        doc.lines[span.endLine - 1] = doc.lines[span.endLine - 1].replace(
          /jump\s+[A-Za-z_]\w*\s*$/,
          `jump ${next}`
        )
        changed = true
        break
      }

      // Fall-through: make it explicit so file order and story order agree.
      materialize(doc, span, next)
      changed = true
      break
    }
    if (!changed) break
  }
  return { text: join(doc), warnings }
}

/** Lines belonging to a label, including the blank lines that follow it. */
function blockRange(doc: Doc, span: LabelSpan): { from: number; to: number } {
  const from = span.startLine - 1
  let to = span.endLine
  while (to < doc.lines.length && doc.lines[to].trim() === '') to++
  return { from, to }
}

export interface RemoveBeatInput {
  /** Text of the file the beat lives in. */
  source: string
  label: string
  /** Every label in the project, so jumps from other files are seen too. */
  jumpsFrom?: Array<{ fileName: string; text: string }>
}

export interface RemoveBeatPlan {
  /** How many lines would go, blank ones after the block included. */
  lines: number
  /** Labels that jump or call this one, wherever they are. */
  referencedBy: string[]
  /**
   * When the scene before this one runs straight into it, what it will run
   * into once this is gone -- or null when there is nothing after it.
   *
   * Nothing is written to preserve this. Falling through to the next label is
   * what fall-through means, and once the block is gone the next label is
   * simply a different one. Writing `jump` to the label being deleted, which
   * is what preserving the old behaviour would literally mean, produces a
   * game that stops there.
   */
  runsIntoInstead: { from: string; to: string | null } | null
  error?: string
}

export interface RemoveBeatResult extends RemoveBeatPlan {
  source: string
}

/** Statements that hand control to a named label. */
const REFERS_TO = (label: string): RegExp =>
  new RegExp(`^\\s*(?:jump|call)\\s+${label}\\s*(?:\\(|$)`, 'm')

/**
 * Everywhere a label is jumped or called from, itself excluded.
 *
 * Ren'Py labels are global, so a scene can be entered from a file that knows
 * nothing about the one it lives in. Looking only at the file being edited
 * would miss exactly the references most likely to be forgotten.
 */
function referencesTo(
  label: string,
  own: Doc,
  ownSpan: LabelSpan,
  elsewhere: Array<{ fileName: string; text: string }>
): string[] {
  const found: string[] = []
  const pattern = REFERS_TO(label)

  const scan = (doc: Doc, where: string, skip?: LabelSpan): void => {
    const spans = spansOf(doc)
    for (const span of spans) {
      if (skip && span.label === skip.label) continue
      const body = doc.lines.slice(span.startLine - 1, span.endLine).join('\n')
      if (pattern.test(body)) found.push(where ? `${span.label} (${where})` : span.label)
    }
  }

  scan(own, '', ownSpan)
  for (const other of elsewhere) scan(split(other.text), other.fileName)
  return found
}

/**
 * What removing a beat would cost, without removing anything.
 *
 * Asked before the confirmation is shown, because "are you sure" is worth
 * nothing next to "47 lines, and two scenes jump here".
 */
export function planRemoveBeat(input: RemoveBeatInput): RemoveBeatPlan {
  const doc = split(input.source)
  const span = spansOf(doc).find((s) => s.label === input.label)
  if (!span) {
    return {
      lines: 0,
      referencedBy: [],
      runsIntoInstead: null,
      error: `${input.label} is not in this file.`
    }
  }
  const { from, to } = blockRange(doc, span)
  const spans = spansOf(doc)
  const index = spans.findIndex((sp) => sp.label === input.label)
  const before = spans[index - 1]
  const after = spans[index + 1]
  const runsIntoInstead =
    before && before.endKind === 'fallthrough' && before.fallsThroughTo === input.label
      ? { from: before.label, to: after ? after.label : null }
      : null

  return {
    lines: to - from,
    referencedBy: referencesTo(input.label, doc, span, input.jumpsFrom ?? []),
    runsIntoInstead
  }
}

/**
 * Cut a label block out of a script.
 *
 * Only the block goes. A scene that ran straight into this one now runs into
 * whatever follows, which is what removing a scene means -- and the plan says
 * so before anybody agrees to it.
 *
 * Refuses while anything still jumps here. A dangling jump is a game that
 * stops at that line, and the writer is far better placed to decide where it
 * should go instead than this is.
 */
export function removeBeat(input: RemoveBeatInput): RemoveBeatResult {
  const plan = planRemoveBeat(input)
  if (plan.error) return { ...plan, source: input.source }
  if (plan.referencedBy.length > 0) {
    return {
      ...plan,
      source: input.source,
      error:
        `${input.label} is still jumped to from ${plan.referencedBy.join(', ')}. ` +
        'Removing it would leave those going nowhere, so nothing was changed.'
    }
  }

  const doc = split(input.source)
  const span = spansOf(doc).find((sp) => sp.label === input.label)!
  const { from, to } = blockRange(doc, span)
  doc.lines.splice(from, to - from)
  doc.eols.splice(from, to - from)

  return { ...plan, source: join(doc) }
}

export interface MoveBeatInput {
  /** Text of the file the beat is leaving. */
  source: string
  /** Text of the file it is joining, or null when moving inside one file. */
  target: string | null
  label: string
  /** Position among the target file's labels; -1 or past the end appends. */
  toIndex: number
  linear: boolean
}

export interface MoveBeatResult {
  source: string
  target: string
  /** Jumps written to preserve behaviour, for reporting back to the writer. */
  materialised: string[]
  /** Places where the new order could not be applied automatically. */
  warnings: string[]
  error?: string
}

/**
 * Move a label block, preserving what the script actually does.
 *
 * Any label whose successor is about to change gets its fall-through written
 * out as a real jump first, so reordering never silently rewires the story.
 * Ren'Py labels are global, so a jump keeps working across files.
 */
export function moveBeat(input: MoveBeatInput): MoveBeatResult {
  const sameFile = input.target === null
  const materialised: string[] = []

  const src = split(input.source)
  let spans = spansOf(src)
  const index = spans.findIndex((s) => s.label === input.label)
  if (index === -1) {
    return {
      source: input.source,
      target: input.target ?? input.source,
      materialised,
      warnings: [],
      error: `${input.label} is not in this file.`
    }
  }

  // The moved label's own fall-through, and its predecessor's.
  const moved = spans[index]
  if (moved.endKind === 'fallthrough' && moved.fallsThroughTo) {
    materialize(src, moved, moved.fallsThroughTo)
    materialised.push(`${moved.label} → ${moved.fallsThroughTo}`)
    spans = spansOf(src)
  }
  const before = spans[spans.findIndex((s) => s.label === input.label) - 1]
  if (before && before.endKind === 'fallthrough' && before.fallsThroughTo) {
    materialize(src, before, before.fallsThroughTo)
    materialised.push(`${before.label} → ${before.fallsThroughTo}`)
    spans = spansOf(src)
  }

  const span = spans.find((s) => s.label === input.label)!
  const { from, to } = blockRange(src, span)
  const blockLines = src.lines.slice(from, to)
  const blockEols = src.eols.slice(from, to)
  src.lines.splice(from, to - from)
  src.eols.splice(from, to - from)

  const dst = sameFile ? src : split(input.target as string)

  // The label the block is being placed before, if any.
  const dstSpans = spansOf(dst)
  const at =
    input.toIndex < 0 || input.toIndex >= dstSpans.length ? dstSpans.length : input.toIndex

  if (at > 0) {
    const prev = dstSpans[at - 1]
    if (prev.endKind === 'fallthrough' && prev.fallsThroughTo) {
      materialize(dst, prev, prev.fallsThroughTo)
      materialised.push(`${prev.label} → ${prev.fallsThroughTo}`)
    }
  }

  const insertAt =
    at >= dstSpans.length ? dst.lines.length : spansOf(dst)[at].startLine - 1

  // Keep a blank line between blocks when appending to a file that has content.
  const needsGap =
    insertAt === dst.lines.length &&
    dst.lines.length > 0 &&
    dst.lines[dst.lines.length - 1].trim() !== ''
  if (needsGap) {
    dst.lines.push('')
    dst.eols.push(nativeEol(dst))
  }

  const eol = nativeEol(dst)
  dst.lines.splice(insertAt + (needsGap ? 1 : 0), 0, ...blockLines)
  dst.eols.splice(insertAt + (needsGap ? 1 : 0), 0, ...blockEols.map((e) => e || eol))

  let sourceText = join(src)
  let targetText = sameFile ? sourceText : join(dst)
  const warnings: string[] = []

  if (input.linear) {
    const relinkedTarget = relinkLinear(targetText)
    targetText = relinkedTarget.text
    warnings.push(...relinkedTarget.warnings)
    if (sameFile) {
      sourceText = targetText
    } else {
      const relinkedSource = relinkLinear(sourceText)
      sourceText = relinkedSource.text
      warnings.push(...relinkedSource.warnings)
    }
  }

  return { source: sourceText, target: targetText, materialised, warnings }
}

export const __testing = { relinkLinear }
