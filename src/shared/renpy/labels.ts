import type { LabelEndKind, LabelSpan, ParsedEpisode } from '@shared/types'

const BOM = '\uFEFF'

const LABEL_RE = /^label\s+([A-Za-z_]\w*)\s*(?:\([^)]*\))?\s*:/
const BARE_JUMP_RE = /^jump\s+([A-Za-z_]\w*)\s*$/
/** Statements that mean the label ends in hand-authored control flow. */
const HAND_AUTHORED_RE = /^(menu\s*:|return\b|call\b|if\b|elif\b|else\s*:|while\b|jump\s+expression\b)/

function indentOf(line: string): number {
  const m = line.match(/^[ \t]*/)
  return m ? m[0].length : 0
}

function isSkippable(line: string): boolean {
  const t = line.trim()
  return t === '' || t.startsWith('#')
}

/**
 * Scan a .rpy file for its top-level labels.
 *
 * Only top-level (column 0) labels become beats. For each we record the line
 * span, whether it ends in a bare `jump X` we are allowed to maintain, and
 * whether it ends in hand-authored control flow that must never be rewritten.
 */
export function parseEpisode(fileName: string, raw: string): ParsedEpisode {
  const hadBom = raw.startsWith(BOM)
  const text = hadBom ? raw.slice(BOM.length) : raw
  const lines = text.split(/\r?\n/)

  // Pass 1: locate top-level label declarations.
  const starts: Array<{ label: string; line: number }> = []
  lines.forEach((line, i) => {
    if (indentOf(line) !== 0) return
    const m = line.match(LABEL_RE)
    if (m) starts.push({ label: m[1], line: i })
  })

  // Pass 2: each label runs until the next top-level label, minus trailing blanks.
  const labels: LabelSpan[] = starts.map((start, idx) => {
    const next = idx + 1 < starts.length ? starts[idx + 1] : null
    const hardEnd = next ? next.line - 1 : lines.length - 1
    let end = hardEnd
    while (end > start.line && lines[end].trim() === '') end--

    // The body indent is set by the first real statement inside the label.
    let bodyIndent: number | null = null
    for (let i = start.line + 1; i <= end; i++) {
      if (isSkippable(lines[i])) continue
      bodyIndent = indentOf(lines[i])
      break
    }

    // The last real statement decides how the label ends.
    let lastIdx = -1
    for (let i = end; i > start.line; i--) {
      if (!isSkippable(lines[i])) {
        lastIdx = i
        break
      }
    }

    let endKind: LabelEndKind = 'fallthrough'
    let trailingJump: string | null = null

    if (lastIdx !== -1 && bodyIndent !== null) {
      const lastLine = lines[lastIdx]
      const trimmed = lastLine.trim()
      const atTopOfBody = indentOf(lastLine) === bodyIndent
      const jump = trimmed.match(BARE_JUMP_RE)

      if (jump && atTopOfBody) {
        endKind = 'jump'
        trailingJump = jump[1]
      } else if (!atTopOfBody || HAND_AUTHORED_RE.test(trimmed)) {
        // Nested inside control flow, or a terminator we must not touch.
        endKind = 'hand-authored'
      }
      // Otherwise the label just runs off its end into the next one.
    }

    // Anything a reader would call content: dialogue, a choice, a stage
    // direction. Structure on its own is a scene waiting to be written.
    let empty = true
    for (let i = start.line + 1; i <= end; i++) {
      const trimmed = lines[i].trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      if (/^(?:pass|return)$/.test(trimmed)) continue
      if (BARE_JUMP_RE.test(trimmed)) continue
      empty = false
      break
    }

    return {
      label: start.label,
      startLine: start.line + 1,
      endLine: end + 1,
      endKind,
      trailingJump,
      fallsThroughTo: endKind === 'fallthrough' ? (next?.label ?? null) : null,
      empty
    }
  })

  return { fileName, labels, lineCount: lines.length, hadBom }
}
