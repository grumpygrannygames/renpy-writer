import { parseEpisode } from './labels'

export interface Linked {
  text: string
  /** Why the new scene could not be joined up, when it could not. */
  notice: string | null
}

const BOM = '﻿'

/**
 * Put a scene that has just been added into the story of a linear episode.
 *
 * The new scene takes over the way out of the scene before it, and the scene
 * before it now leads into the new one. So wherever the story went from there
 * before -- running on into the next scene, jumping to the next episode, or
 * stopping at the end of the file -- it still goes, only now by way of the
 * scene that was added:
 *
 *     A falls through      ->  A jumps to NEW, NEW falls through
 *     A jumps to B         ->  A jumps to NEW, NEW jumps to B
 *
 * Without this, adding a scene at the end of an episode left the one before it
 * falling through, and adding one between two scenes left it stranded: the
 * scene before kept jumping over it to where it always had.
 *
 * A scene that ends in its own control flow -- a menu, a return, an if -- is
 * left exactly as written. Where that story goes next is the writer's call,
 * and the notice says so rather than guessing.
 */
export function linkThrough(text: string, previous: string, added: string): Linked {
  const unchanged = { text, notice: null }
  const spans = parseEpisode('memory', text).labels
  const before = spans.find((s) => s.label === previous)
  const fresh = spans.find((s) => s.label === added)
  if (!before || !fresh || before === fresh) return unchanged

  if (before.endKind === 'hand-authored') {
    return {
      text,
      notice:
        `${previous} ends in its own control flow, so it does not lead into ${added}. ` +
        `Add a jump where the story should go on.`
    }
  }

  const hadBom = text.startsWith(BOM)
  const body = hadBom ? text.slice(BOM.length) : text
  // Lines and the terminators after them, so a file keeps its own line endings.
  const lines: string[] = []
  const eols: string[] = []
  const re = /\r?\n/g
  let from = 0
  for (let m = re.exec(body); m; m = re.exec(body)) {
    lines.push(body.slice(from, m.index))
    eols.push(m[0])
    from = m.index + m[0].length
  }
  lines.push(body.slice(from))
  eols.push('')
  const eol = eols.find((e) => e) ?? '\n'

  /** Where a label's own statements start, and the indent they use. */
  const bodyOf = (span: { startLine: number; endLine: number }) => {
    // startLine and endLine are 1-indexed and inclusive; startLine is the label.
    const real: number[] = []
    for (let i = span.startLine; i < span.endLine; i++) {
      const t = lines[i]?.trim() ?? ''
      if (t && !t.startsWith('#')) real.push(i)
    }
    const first = real[0]
    const indent =
      first === undefined ? '    ' : lines[first].slice(0, lines[first].length - lines[first].trimStart().length)
    return { real, indent: indent || '    ' }
  }

  /**
   * End a scene with `jump target`.
   *
   * A scene with nothing in it but `pass` has the placeholder swapped for the
   * jump -- a beat reading `pass` and then `jump` says two things at once.
   * Only when `pass` is all there is: with words under it, it would put the
   * jump in front of them.
   */
  const endWithJump = (span: { startLine: number; endLine: number }, target: string): void => {
    const { real, indent } = bodyOf(span)
    if (real.length === 1 && lines[real[0]].trim() === 'pass') {
      lines[real[0]] = `${indent}jump ${target}`
      return
    }
    // After the last line of the scene, which is endLine (1-indexed). If that
    // line is the last in a file with no newline at the end, it takes one, or
    // the jump would be written onto the end of it.
    const at = span.endLine
    if (eols[at - 1] === '') {
      eols[at - 1] = eol
      lines.splice(at, 0, `${indent}jump ${target}`)
      eols.splice(at, 0, '')
    } else {
      lines.splice(at, 0, `${indent}jump ${target}`)
      eols.splice(at, 0, eol)
    }
  }

  // The later scene first, so the earlier one's line numbers still hold.
  if (before.endKind === 'jump' && before.trailingJump) {
    endWithJump(fresh, before.trailingJump)
    const last = before.endLine - 1
    lines[last] = lines[last].replace(/jump\s+[A-Za-z_]\w*\s*$/, `jump ${added}`)
  } else {
    endWithJump(before, added)
  }

  let out = ''
  for (let i = 0; i < lines.length; i++) out += lines[i] + eols[i]
  return { text: (hadBom ? BOM : '') + out, notice: null }
}
