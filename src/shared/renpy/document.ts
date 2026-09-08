/**
 * Line-level document model for a .rpy file.
 *
 * Every source line becomes exactly one node, and every node keeps the text it
 * came from in `raw`. Serialising emits `raw` verbatim for anything the writer
 * has not touched, so constructs the editor does not understand -- menus, if
 * blocks, transforms, python -- survive a round trip byte for byte. Only nodes
 * that were actually edited are regenerated from their fields.
 */

export type NodeKind = 'label' | 'dialogue' | 'choice' | 'action' | 'raw' | 'blank'

interface NodeBase {
  /** Stable within one parsed document; used for React keys and edits. */
  id: string
  /** Leading whitespace, preserved exactly. */
  indent: string
  /** Original source text without its terminator, or null once edited. */
  raw: string | null
  /** The line terminator that followed this line ('\r\n', '\n', or '' at EOF). */
  eol: string
}

export interface LabelNode extends NodeBase {
  kind: 'label'
  name: string
}

export interface DialogueNode extends NodeBase {
  kind: 'dialogue'
  /** Ren'Py character variable, or null for a narrator line. */
  speaker: string | null
  /** Expression attributes, e.g. ['serious']. */
  attributes: string[]
  /** Inner text in source form, still carrying \" escapes and {i} markup. */
  text: string
}

export interface ChoiceNode extends NodeBase {
  kind: 'choice'
  text: string
}

export interface ActionNode extends NodeBase {
  kind: 'action'
  text: string
}

export interface RawNode extends NodeBase {
  kind: 'raw'
}

export interface BlankNode extends NodeBase {
  kind: 'blank'
}

export type ScriptNode =
  | LabelNode
  | DialogueNode
  | ChoiceNode
  | ActionNode
  | RawNode
  | BlankNode

export interface ScriptDocument {
  nodes: ScriptNode[]
  hadBom: boolean
}

const BOM = '\uFEFF'

/**
 * Words that begin a Ren'Py statement. A line starting with one of these is
 * never a line of dialogue, which is what stops `play music "x.mp3"` and
 * `image side alice = "y.png"` from being read as a character speaking.
 */
const RESERVED = new Set([
  'label', 'jump', 'call', 'return', 'menu', 'if', 'elif', 'else', 'while', 'pass',
  'scene', 'show', 'hide', 'play', 'stop', 'queue', 'pause', 'window', 'nvl',
  'voice', 'with', 'at', 'as', 'behind', 'onlayer', 'zorder', 'expression',
  'define', 'default', 'image', 'transform', 'screen', 'init', 'python', 'style',
  'extend', 'camera', 'layeredimage', 'translate', 'testcase', 'text', 'add',
  'use', 'hbox', 'vbox', 'frame', 'imagemap', 'input', 'key', 'timer'
])

const LABEL_RE = /^label\s+([A-Za-z_]\w*)\s*(?:\([^)]*\))?\s*:\s*$/
const CHOICE_RE = /^"((?:[^"\\]|\\.)*)"\s*:\s*$/
const NARRATOR_RE = /^"((?:[^"\\]|\\.)*)"\s*$/
const SPEECH_RE = /^([A-Za-z_]\w*)((?:\s+[A-Za-z_]\w*)*)\s+"((?:[^"\\]|\\.)*)"\s*$/

/** Split into lines while keeping each line's own terminator. */
function splitLines(text: string): Array<{ body: string; eol: string }> {
  const out: Array<{ body: string; eol: string }> = []
  const re = /([^\r\n]*)(\r\n|\n|\r|$)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    out.push({ body: m[1], eol: m[2] })
    // The final iteration matches an empty body with an empty terminator.
    if (m[2] === '' || re.lastIndex >= text.length) break
  }
  // A trailing terminator produces a final empty entry we do not want.
  if (out.length > 0 && out[out.length - 1].body === '' && out[out.length - 1].eol === '') {
    const prev = out[out.length - 2]
    if (prev && prev.eol !== '') out.pop()
  }
  return out
}

export function parseDocument(source: string): ScriptDocument {
  const hadBom = source.startsWith(BOM)
  const text = hadBom ? source.slice(BOM.length) : source
  const nodes: ScriptNode[] = []

  splitLines(text).forEach((line, i) => {
    const id = `n${i}`
    const indentMatch = line.body.match(/^[ \t]*/)
    const indent = indentMatch ? indentMatch[0] : ''
    const rest = line.body.slice(indent.length)
    const base = { id, indent, raw: line.body, eol: line.eol }

    if (rest.trim() === '') {
      nodes.push({ ...base, kind: 'blank' })
      return
    }

    if (rest.startsWith('#')) {
      nodes.push({ ...base, kind: 'action', text: rest.replace(/^#\s?/, '') })
      return
    }

    const label = rest.match(LABEL_RE)
    if (label) {
      nodes.push({ ...base, kind: 'label', name: label[1] })
      return
    }

    const choice = rest.match(CHOICE_RE)
    if (choice) {
      nodes.push({ ...base, kind: 'choice', text: choice[1] })
      return
    }

    const narrator = rest.match(NARRATOR_RE)
    if (narrator) {
      nodes.push({ ...base, kind: 'dialogue', speaker: null, attributes: [], text: narrator[1] })
      return
    }

    const speech = rest.match(SPEECH_RE)
    if (speech && !RESERVED.has(speech[1])) {
      nodes.push({
        ...base,
        kind: 'dialogue',
        speaker: speech[1],
        attributes: speech[2].trim() === '' ? [] : speech[2].trim().split(/\s+/),
        text: speech[3]
      })
      return
    }

    nodes.push({ ...base, kind: 'raw' })
  })

  return { nodes, hadBom }
}

/** Regenerate a node's source text from its fields. */
export function renderNode(node: ScriptNode): string {
  switch (node.kind) {
    case 'label':
      return `${node.indent}label ${node.name}:`
    case 'action':
      return `${node.indent}# ${node.text}`
    case 'choice':
      return `${node.indent}"${node.text}":`
    case 'dialogue': {
      const attrs = node.attributes.length ? ' ' + node.attributes.join(' ') : ''
      const head = node.speaker ? `${node.speaker}${attrs} ` : ''
      return `${node.indent}${head}"${node.text}"`
    }
    case 'blank':
      return node.indent
    case 'raw':
      return node.raw ?? ''
  }
}

export function serializeDocument(doc: ScriptDocument): string {
  const body = doc.nodes.map((n) => (n.raw !== null ? n.raw : renderNode(n)) + n.eol).join('')
  return doc.hadBom ? BOM + body : body
}

/**
 * Whether a node is a bare `pass` on a line of its own.
 */
function isPass(node: ScriptNode): boolean {
  return node.kind === 'raw' && (node.raw ?? '').trim() === 'pass'
}

/**
 * Drop the placeholder from a scene that has stopped needing it.
 *
 * A beat planned in the outline is written as `label X:` and a `pass`, which
 * is the app saying "nothing here yet" in a way Ren'Py can read. Once the
 * first line of the scene arrives, the placeholder is just a line nobody
 * wrote, so it goes with the same edit that made it unnecessary.
 *
 * Only the `pass` directly beneath a label is ever touched, and only when
 * something else is under that label too. Scripts are full of `pass` inside a
 * menu choice or an `else:`, where it is not a placeholder but the only thing
 * keeping that block legal -- removing one of those from an edit elsewhere in
 * the file would break the game.
 *
 * Nothing is ever added. A label with an empty block is Ren'Py's business and
 * it loads them quite happily; one real project here ships eleven. Writing a
 * `pass` into those would turn opening a file and typing one word into a
 * diff of every scene in it.
 */
export function dropSpentPass(nodes: ScriptNode[]): ScriptNode[] {
  const out: ScriptNode[] = []
  let changed = false
  let i = 0

  while (i < nodes.length) {
    const node = nodes[i]
    out.push(node)
    i++
    if (node.kind !== 'label') continue

    const start = i
    while (i < nodes.length && nodes[i].kind !== 'label') i++
    const body = nodes.slice(start, i)

    const written = body.filter((n) => n.kind !== 'blank')
    if (written.length > 1 && isPass(written[0])) {
      changed = true
      out.push(...body.filter((n) => n !== written[0]))
      continue
    }
    out.push(...body)
  }

  return changed ? out : nodes
}

/** Mark a node as edited so it is regenerated rather than emitted verbatim. */
export function touch<T extends ScriptNode>(node: T, changes: Partial<T>): T {
  return { ...node, ...changes, raw: null }
}

// ------------------------------------------------------------ text escaping

/** Source form -> what a person should see and type. */
export function unescapeText(text: string): string {
  return text.replace(/\\(["\\])/g, '$1')
}

/** What a person typed -> source form. */
export function escapeText(text: string): string {
  return text.replace(/([\\"])/g, '\\$1')
}

// ------------------------------------------------------------ inline markup

/**
 * Ren'Py inline markup, which is what bold and italic in the writer map onto.
 * Kept deliberately small: anything else stays literal in the text.
 */
export const MARKUP = {
  bold: { open: '{b}', close: '{/b}' },
  italic: { open: '{i}', close: '{/i}' },
  strike: { open: '{s}', close: '{/s}' },
  underline: { open: '{u}', close: '{/u}' }
} as const

export type MarkupKind = keyof typeof MARKUP

/** Wrap (or unwrap) a selection in one of the markup pairs. */
export function toggleMarkup(text: string, start: number, end: number, kind: MarkupKind): {
  text: string
  start: number
  end: number
} {
  const { open, close } = MARKUP[kind]
  const selected = text.slice(start, end)

  if (selected.startsWith(open) && selected.endsWith(close) && selected.length >= open.length + close.length) {
    const inner = selected.slice(open.length, selected.length - close.length)
    return { text: text.slice(0, start) + inner + text.slice(end), start, end: start + inner.length }
  }

  const before = text.slice(0, start)
  const after = text.slice(end)
  if (before.endsWith(open) && after.startsWith(close)) {
    return {
      text: before.slice(0, -open.length) + selected + after.slice(close.length),
      start: start - open.length,
      end: end - open.length
    }
  }

  const wrapped = open + selected + close
  return { text: before + wrapped + after, start: start + open.length, end: end + open.length }
}

/**
 * Nudge the relative font size of a selection, e.g. {size=+4}...{/size}.
 *
 * Ren'Py does not accumulate nested size tags predictably, so an existing
 * wrapper is adjusted in place rather than wrapped again, and a size of zero
 * removes the tags entirely.
 */
export function adjustSize(
  text: string,
  start: number,
  end: number,
  delta: number
): { text: string; start: number; end: number } {
  if (delta === 0) return { text, start, end }

  const selected = text.slice(start, end)
  const inner = /^\{size=([+-]?\d+)\}([\s\S]*)\{\/size\}$/.exec(selected)

  // The selection itself is a sized run.
  if (inner) {
    const next = Number(inner[1]) + delta
    const body = inner[2]
    const replacement = next === 0 ? body : `{size=${next > 0 ? '+' : ''}${next}}${body}{/size}`
    return {
      text: text.slice(0, start) + replacement + text.slice(end),
      start,
      end: start + replacement.length
    }
  }

  // The selection sits inside a sized run.
  const before = text.slice(0, start)
  const after = text.slice(end)
  const openBefore = /\{size=([+-]?\d+)\}$/.exec(before)
  if (openBefore && after.startsWith('{/size}')) {
    const next = Number(openBefore[1]) + delta
    const head = before.slice(0, before.length - openBefore[0].length)
    const tail = after.slice('{/size}'.length)
    if (next === 0) {
      return { text: head + selected + tail, start: head.length, end: head.length + selected.length }
    }
    const tag = `{size=${next > 0 ? '+' : ''}${next}}`
    return {
      text: head + tag + selected + '{/size}' + tail,
      start: head.length + tag.length,
      end: head.length + tag.length + selected.length
    }
  }

  const tag = `{size=${delta > 0 ? '+' : ''}${delta}}`
  return {
    text: before + tag + selected + '{/size}' + after,
    start: start + tag.length,
    end: end + tag.length
  }
}
