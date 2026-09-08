import {
  Fragment,
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type ReactNode
} from 'react'
import type { PassMode } from '@shared/api'
import type { DiscoveredCharacter } from '@shared/types'
import { centreIndex, nearestLine } from '../anchor'
import { readableOn } from '../color'
import { buildLabeller, type Labeller } from '../characterLabel'
import { matchSpeakers } from '../speakerMatch'
import { freeName } from '@shared/renpy/names'
import {
  parseDocument,
  serializeDocument,
  adjustSize,
  dropSpentPass,
  toggleMarkup,
  touch,
  unescapeText,
  escapeText,
  type MarkupKind,
  type ScriptDocument,
  type ScriptNode
} from '@shared/renpy/document'
import { api } from '../api'
import ContextMenu, { type MenuPosition } from './ContextMenu'
import FindBar from './FindBar'
import { matchingIndexes, step } from '../find'

interface Props {
  docKey: string
  value: string
  onChange: (value: string) => void
  characters: DiscoveredCharacter[]
  expressionsEnabled: boolean
  revealLine?: number | null
  /** Absolute path of the project, for loading portrait previews. */
  renpyRoot: string
  /**
   * Reports the line at the vertical centre of the viewport, which is what
   * Writer <-> Code switching uses to keep your reading position.
   */
  onAnchorLine?: (line: number) => void
  /** Ctrl+click on a character cue asks to reveal them in the reference panel. */
  onRevealCharacter?: (varName: string) => void
  /** Translate or proofread one beat, given its label and 1-indexed line range. */
  onBeatPass?: (mode: PassMode, beat: { label: string; from: number; to: number }) => void
  /**
   * Labels used by the rest of the project. Ren'Py labels are global, so a
   * name is only free if it is free in every file, and this view can only see
   * one of them.
   */
  otherLabels?: string[]
  /**
   * Take a beat out of the story altogether. Handled outside this view because
   * it writes to the file rather than to the document in hand: the outline
   * entry has to go with it, or the beat comes back as an unwritten one.
   */
  onRemoveBeat?: (label: string) => void
}

type Field = 'speaker' | 'text'

/**
 * Element types the writer can turn a block into.
 *
 * Not choice. A choice is one option inside a `menu:`, and a line of dialogue
 * turned into one on its own is a script that will not load: there is no menu
 * around it, and nothing here could say where that menu ought to end. Choices
 * written in the script are still shown as choices -- they read far better
 * than the source does -- they just cannot be made or unmade from here.
 */
const CYCLE: Array<ScriptNode['kind']> = ['dialogue', 'action']

/** Must match --bg in styles.css. */
const WRITER_BG = '#16161a'

let idSeq = 0
const nextId = (): string => `w${idSeq++}`

/**
 * Screenplay view over the document model.
 *
 * Only the block being edited renders as a real input; everything else is a
 * plain div. A finished chapter runs to several thousand lines, and mounting
 * that many textareas is what makes this kind of editor crawl.
 */
export default function WriterView({
  docKey,
  value,
  onChange,
  characters,
  expressionsEnabled,
  revealLine,
  renpyRoot,
  onAnchorLine,
  onRevealCharacter,
  onBeatPass,
  otherLabels,
  onRemoveBeat
}: Props) {
  const [doc, setDoc] = useState<ScriptDocument>(() => parseDocument(value))
  const [editing, setEditing] = useState<{ id: string; field: Field } | null>(null)
  const [showCode, setShowCode] = useState(false)
  const lastSerialized = useRef(value)
  const docRef = useRef(doc)
  docRef.current = doc
  const scroller = useRef<HTMLDivElement>(null)
  const pendingFocus = useRef<{ id: string; field: Field; selectAll?: boolean } | null>(null)
  /**
   * Labels made here, which are the only ones a rename may upper-case.
   *
   * A beat created in this view is named by typing into the label, the same
   * input that renames an existing one -- and upper-casing what somebody types
   * over `ch2_dream` would rename a label the rest of the script jumps to.
   */
  const freshLabels = useRef<Set<string>>(new Set())
  const [labelMenu, setLabelMenu] = useState<{ id: string; at: MenuPosition } | null>(null)
  const [finding, setFinding] = useState(false)
  const [query, setQuery] = useState('')
  const [match, setMatch] = useState(0)
  const [findNonce, setFindNonce] = useState(0)
  /** Recomputes the anchor; set once the scroller is listening. */
  const reportRef = useRef<(() => void) | null>(null)
  /**
   * Line we are scrolling towards. While set, intermediate scroll positions are
   * ignored so that mounting at the top of the file cannot destroy the anchor
   * we were asked to restore. It clears on arrival, on any real user gesture,
   * or after a short grace period, so it can never wedge reporting shut.
   */
  const pendingReveal = useRef<number | null>(null)
  const revealRef = useRef(revealLine)
  revealRef.current = revealLine
  const guardTimer = useRef<number>(0)
  const armGuard = (line: number | null): void => {
    pendingReveal.current = line
    if (guardTimer.current) clearTimeout(guardTimer.current)
    if (line !== null) {
      guardTimer.current = window.setTimeout(() => {
        pendingReveal.current = null
      }, 1000)
    }
  }

  // Reparse only when the text changed outside this component (a code-view
  // edit, a file reload); otherwise our own edits would clobber the cursor.
  useEffect(() => {
    if (value !== lastSerialized.current) {
      setDoc(parseDocument(value))
      lastSerialized.current = value
      setEditing(null)
    }
  }, [value, docKey])

  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange

  const commit = useCallback((nodes: ScriptNode[]) => {
    // The placeholder in a planned scene goes as soon as there are words.
    const next = { ...docRef.current, nodes: dropSpentPass(nodes) }
    docRef.current = next
    setDoc(next)
    const text = serializeDocument(next)
    lastSerialized.current = text
    onChangeRef.current(text)
  }, [])

  const byVar = useMemo(
    () => new Map(characters.map((c) => [c.varName, c])),
    [characters]
  )
  const labeller = useMemo(() => buildLabeller(characters), [characters])

  // Scrolling here comes from an outline click, which knows source line numbers.
  useLayoutEffect(() => {
    if (!revealLine || !scroller.current) return
    // The code view counts every line; this one draws only some of them. Land
    // on the nearest block at or above the line asked for rather than nowhere.
    const drawn = Array.from(
      scroller.current.querySelectorAll<HTMLElement>('[data-line]')
    ).map((el) => Number(el.dataset.line))
    const line = nearestLine(drawn, revealLine)
    if (line === null) return
    // Armed with where we are going, not where we were asked to go, or the
    // first report back would look like a disagreement and be thrown away.
    armGuard(line)
    const target = scroller.current.querySelector(`[data-line="${line}"]`)
    target?.scrollIntoView({ block: 'center' })
    // Recompute as the scroll settles instead of waiting for the event.
    const timers = [80, 250].map((ms) => window.setTimeout(() => reportRef.current?.(), ms))
    return () => timers.forEach(clearTimeout)
  }, [revealLine, docKey])

  useLayoutEffect(() => {
    const want = pendingFocus.current
    if (!want) return
    pendingFocus.current = null
    const el = scroller.current?.querySelector<HTMLElement>(
      `[data-edit="${want.id}-${want.field}"]`
    )
    el?.focus()
    if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) {
      if (want.selectAll) el.select()
      else {
        const len = el.value.length
        el.setSelectionRange(len, len)
      }
    }
  })

  const onAnchorLineRef = useRef(onAnchorLine)
  onAnchorLineRef.current = onAnchorLine

  const focusOn = useCallback((id: string, field: Field, selectAll = false) => {
    setEditing({ id, field })
    pendingFocus.current = { id, field, selectAll }
  }, [])

  const stopEditing = useCallback(() => setEditing(null), [])

  const replaceNode = useCallback(
    (id: string, updater: (n: ScriptNode) => ScriptNode) => {
      commit(docRef.current.nodes.map((n) => (n.id === id ? updater(n) : n)))
    },
    [commit]
  )

  /** Insert a fresh dialogue block after `id` and start editing it. */
  const insertAfter = useCallback((id: string) => {
    const nodes0 = docRef.current.nodes
    const idx = nodes0.findIndex((n) => n.id === id)
    if (idx === -1) return
    const anchor = nodes0[idx]
    const created: ScriptNode = {
      id: nextId(),
      kind: 'dialogue',
      indent: anchor.indent || '    ',
      raw: null,
      eol: anchor.eol || '\n',
      speaker: null,
      attributes: [],
      text: ''
    }
    const nodes = [...nodes0]
    nodes.splice(idx + 1, 0, created)
    commit(nodes)
    focusOn(created.id, 'speaker')
  }, [commit, focusOn])

  /** Index just past the last node belonging to the label at `idx`. */
  const beatEnd = (nodes: ScriptNode[], idx: number): number => {
    let i = idx + 1
    while (i < nodes.length && nodes[i].kind !== 'label') i++
    return i
  }

  /**
   * Give the node at `index` a line terminator if it has none.
   *
   * The last line of a file that does not end in a newline is held with an
   * empty terminator. Insert after it and the two lines are serialised into
   * one, so `label NEW_BEAT:` arrives welded to the end of the last sentence.
   */
  const terminate = (nodes: ScriptNode[], index: number, eol: string): void => {
    const node = nodes[index]
    if (node && node.eol === '') nodes[index] = { ...node, eol }
  }

  /** The indent a line inside this beat should have. */
  const bodyIndent = (nodes: ScriptNode[], idx: number): string => {
    for (let i = idx + 1; i < beatEnd(nodes, idx); i++) {
      if (nodes[i].kind !== 'blank' && nodes[i].indent) return nodes[i].indent
    }
    return '    '
  }

  /**
   * A label nobody else is using, here or in any other episode.
   *
   * Compared without case: Ren'Py would take FOO and foo as two labels, being
   * case-sensitive, but nobody reading the script would thank us.
   */
  const freeLabel = useCallback(
    (want: string, exceptId: string): string => {
      const taken = new Set<string>((otherLabels ?? []).map((l) => l.toLowerCase()))
      for (const node of docRef.current.nodes) {
        if (node.kind === 'label' && node.id !== exceptId) taken.add(node.name.toLowerCase())
      }
      return freeName(want, (candidate) => taken.has(candidate.toLowerCase()))
    },
    [otherLabels]
  )

  /**
   * Start writing a scene that has nothing in it.
   *
   * An empty beat is a label and a `pass`, which is there only to keep the
   * label valid -- Ren'Py will not load a block with nothing in it. The `pass`
   * is hidden in this view, so the scene looked like a heading with no way in:
   * nothing to click, and Enter with no line to press it on. The first real
   * line takes the `pass` with it.
   */
  const startBeat = useCallback((labelId: string) => {
    const nodes0 = docRef.current.nodes
    const idx = nodes0.findIndex((n) => n.id === labelId)
    if (idx === -1) return
    const anchor = nodes0[idx]
    const indent = bodyIndent(nodes0, idx)

    // Below the placeholder rather than above it: `dropSpentPass` only takes
    // a `pass` that is the first thing under the label, and being careful
    // about which `pass` it takes is what keeps it safe.
    const after = (() => {
      for (let i = idx + 1; i < beatEnd(nodes0, idx); i++) {
        if (nodes0[i].kind === 'blank') continue
        return nodes0[i].kind === 'raw' && (nodes0[i].raw ?? '').trim() === 'pass' ? i : idx
      }
      return idx
    })()

    const nodes = [...nodes0]
    const created: ScriptNode = {
      id: nextId(),
      kind: 'dialogue',
      indent,
      raw: null,
      eol: anchor.eol || '\n',
      speaker: null,
      attributes: [],
      text: ''
    }
    const at = after + 1
    terminate(nodes, after, created.eol)
    nodes.splice(at, 0, created)
    commit(nodes)
    focusOn(created.id, 'speaker')
  }, [commit, focusOn])

  /**
   * A new scene, either after the one at `labelId` or at the end of the file.
   *
   * Shaped exactly like a beat made from the plot board -- a label and a
   * `pass` -- so the two are the same thing however it was made. The name is
   * typed straight into the label, which is where a beat is named here.
   */
  const addBeat = useCallback((labelId: string | null) => {
    const nodes0 = docRef.current.nodes
    const idx = labelId === null ? -1 : nodes0.findIndex((n) => n.id === labelId)
    const at = idx === -1 ? nodes0.length : beatEnd(nodes0, idx)
    const eol = nodes0[nodes0.length - 1]?.eol || '\n'
    const indent = idx === -1 ? '    ' : bodyIndent(nodes0, idx)

    const label: ScriptNode = {
      id: nextId(),
      kind: 'label',
      indent: '',
      raw: null,
      eol,
      name: freeLabel('NEW_BEAT', '')
    }
    const body: ScriptNode = {
      id: nextId(),
      kind: 'raw',
      indent,
      raw: `${indent}pass`,
      eol
    }

    const added: ScriptNode[] = [label, body]
    // One blank line between scenes, and no more than one.
    if (at > 0 && nodes0[at - 1].kind !== 'blank') {
      added.unshift({ id: nextId(), kind: 'blank', indent: '', raw: null, eol })
    }

    const nodes = [...nodes0]
    terminate(nodes, at - 1, eol)
    nodes.splice(at, 0, ...added)
    freshLabels.current.add(label.id)
    commit(nodes)
    focusOn(label.id, 'text', true)
  }, [commit, focusOn, freeLabel])

  /**
   * Rename a label to what was typed, near enough.
   *
   * Ren'Py names cannot carry spaces or punctuation, so those become
   * underscores. A beat made a moment ago is upper-cased to match the ones the
   * plot board writes; one that was already in the script is left as typed,
   * because it is a name the rest of the script may be jumping to.
   */
  const renameLabel = useCallback((id: string, typed: string) => {
    const node = docRef.current.nodes.find((n) => n.id === id)
    if (!node || node.kind !== 'label') return
    let name = typed.trim().replace(/[^A-Za-z0-9_]/g, '_').replace(/^_+|_+$/g, '')
    if (!name) return
    if (freshLabels.current.has(id)) name = name.toUpperCase()
    if (/^[0-9]/.test(name)) name = `BEAT_${name}`
    name = freeLabel(name, id)
    if (name === node.name) return
    replaceNode(id, (n) => touch(n as never, { name } as never))
  }, [freeLabel, replaceNode])

  /**
   * Turn a block into another kind of element, keeping its words.
   *
   * Reachable by name rather than only by cycling, because Tab does not exist
   * on a phone -- and without this there was no way at all to turn a line into
   * an action there.
   */
  const setKind = useCallback((id: string, kind: ScriptNode['kind']) => {
    const node = docRef.current.nodes.find((n) => n.id === id)
    if (!node || node.kind === kind) return
    // A choice belongs to the menu it is written in. Turning one into dialogue
    // takes the colon off the end and leaves the menu with an option that is
    // not an option; turning dialogue into one puts an option where no menu is
    // listening. Both are scripts that will not load.
    if (node.kind === 'choice' || kind === 'choice') return
    const text = node.kind === 'dialogue' || node.kind === 'action' ? node.text : ''

    replaceNode(id, (n) => {
      const base = { id: n.id, indent: n.indent, raw: null, eol: n.eol }
      if (kind === 'dialogue') {
        return { ...base, kind: 'dialogue', speaker: null, attributes: [], text }
      }
      if (kind === 'action') return { ...base, kind: 'action', text }
      return { ...base, kind: 'choice', text }
    })
    focusOn(id, 'text')
  }, [replaceNode, focusOn])

  /** Tab still cycles; it just goes through the same door now. */
  const cycleKind = useCallback((id: string) => {
    const node = docRef.current.nodes.find((n) => n.id === id)
    if (!node) return
    const current = CYCLE.indexOf(node.kind as (typeof CYCLE)[number])
    if (current === -1) return
    setKind(id, CYCLE[(current + 1) % CYCLE.length])
  }, [setKind])

  const removeNode = useCallback((id: string) => {
    const nodes0 = docRef.current.nodes
    const idx = nodes0.findIndex((n) => n.id === id)
    if (idx <= 0) return
    commit(nodes0.filter((n) => n.id !== id))
    const prev = nodes0[idx - 1]
    if (prev) focusOn(prev.id, 'text')
  }, [commit, focusOn])

  const applyMarkup = useCallback((id: string, el: HTMLTextAreaElement, kind: MarkupKind) => {
    const node = docRef.current.nodes.find((n) => n.id === id)
    // Markup only means anything inside a Ren'Py string. An action line is a
    // comment, so escaping and tagging it would just corrupt the comment.
    if (!node || (node.kind !== 'dialogue' && node.kind !== 'choice')) return

    const result = toggleMarkup(el.value, el.selectionStart, el.selectionEnd, kind)

    // The textarea is uncontrolled, so React will not push this back into the
    // DOM. Update the element itself or the change is invisible and the next
    // blur overwrites it with the stale value.
    el.value = result.text
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
    el.setSelectionRange(result.start, result.end)

    replaceNode(id, (n) => touch(n as never, { text: escapeText(result.text) } as never))
  }, [replaceNode])

  const applySize = useCallback((id: string, el: HTMLTextAreaElement, delta: number) => {
    const node = docRef.current.nodes.find((n) => n.id === id)
    if (!node || (node.kind !== 'dialogue' && node.kind !== 'choice')) return

    const result = adjustSize(el.value, el.selectionStart, el.selectionEnd, delta)
    el.value = result.text
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
    el.setSelectionRange(result.start, result.end)

    replaceNode(id, (n) => touch(n as never, { text: escapeText(result.text) } as never))
  }, [replaceNode])

  // Ctrl+F, or Cmd+F, wherever the caret happens to be.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'f') {
        e.preventDefault()
        setFinding(true)
        setFindNonce((v) => v + 1)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Report the line under the middle of the viewport as the sync anchor.
  useEffect(() => {
    const el = scroller.current
    if (!el) return

    // Throttled with a timer rather than requestAnimationFrame, which Chromium
    // throttles hard once the window is hidden or minimised.
    let timer = 0
    const report = (): void => {
      timer = 0
      const middle = el.scrollTop + el.clientHeight / 2
      // Only the children that stand for a line of the file. The invitation to
      // start an empty scene is a child too, and reporting nothing at all
      // because the middle of the screen landed on one would freeze the anchor.
      const tops: number[] = []
      const lines: number[] = []
      for (const kid of Array.from(el.children) as HTMLElement[]) {
        if (!kid.dataset.line) continue
        tops.push(kid.offsetTop)
        lines.push(Number(kid.dataset.line))
      }
      const best = centreIndex(tops, middle)
      if (best < 0) return
      const line = lines[best]

      const target = pendingReveal.current
      if (target !== null) {
        if (Math.abs(line - target) > 2) return
        pendingReveal.current = null
      }
      onAnchorLineRef.current?.(line)
    }

    const onScroll = (): void => {
      if (timer === 0) timer = window.setTimeout(report, 60)
    }
    const release = (): void => armGuard(null)
    el.addEventListener('scroll', onScroll, { passive: true })
    el.addEventListener('wheel', release, { passive: true })
    el.addEventListener('pointerdown', release, { passive: true })
    reportRef.current = report
    // Arm before the first report so mounting at the top of the file cannot
    // clobber the anchor a pending reveal is about to restore.
    armGuard(revealRef.current ?? null)
    report()

    return () => {
      reportRef.current = null
      el.removeEventListener('scroll', onScroll)
      el.removeEventListener('wheel', release)
      el.removeEventListener('pointerdown', release)
      if (guardTimer.current) clearTimeout(guardTimer.current)
      if (timer) clearTimeout(timer)
    }
    // Reads the DOM only, so it must not re-run (and re-arm) on every edit.
  }, [docKey])

  const visible = useMemo(
    () => (showCode ? doc.nodes : doc.nodes.filter((n) => n.kind !== 'raw')),
    [doc, showCode]
  )

  /**
   * The words on the page, one entry per block.
   *
   * What is searched is what is shown: the line as the writer reads it rather
   * than the Ren'Py behind it, so looking for a quotation mark does not turn
   * up every line of dialogue in the file.
   */
  const searchable = useMemo(
    () =>
      visible.map((node) => {
        if (node.kind === 'label') return node.name
        if (node.kind === 'dialogue' || node.kind === 'choice') return unescapeText(node.text)
        if (node.kind === 'action') return node.text
        return node.raw ?? ''
      }),
    [visible]
  )
  const matches = useMemo(() => matchingIndexes(searchable, query), [searchable, query])
  const at = matches.length > 0 ? Math.min(match, matches.length - 1) : -1
  const foundIds = useMemo(() => new Set(matches.map((i) => visible[i].id)), [matches, visible])
  const currentId = at >= 0 ? visible[matches[at]].id : null

  // A new search starts at the top of it.
  useEffect(() => setMatch(0), [query])

  // Source line per node, kept accurate across edits rather than read off the id.
  const lineOf = useMemo(() => {
    const map = new Map<string, number>()
    doc.nodes.forEach((n, i) => map.set(n.id, i + 1))
    return map
  }, [doc])

  /**
   * Labels with nothing under them to click.
   *
   * Not the same question as whether the outline calls a beat unwritten: a
   * scene holding only a stage direction is unwritten there, but here it has a
   * block you can put the cursor in, which is all this is deciding.
   */
  const barren = useMemo(() => {
    const empty = new Set<string>()
    let current: string | null = null
    for (const node of doc.nodes) {
      if (node.kind === 'label') {
        current = node.id
        empty.add(node.id)
        continue
      }
      if (!current) continue
      if (node.kind === 'dialogue' || node.kind === 'choice' || node.kind === 'action') {
        empty.delete(current)
      }
    }
    return empty
  }, [doc])

  /** Line range of each label block, for translating one beat at a time. */
  const beatRange = useMemo(() => {
    const map = new Map<string, { label: string; from: number; to: number }>()
    const labels = doc.nodes
      .map((n, i) => ({ node: n, line: i + 1 }))
      .filter((x) => x.node.kind === 'label')
    labels.forEach((entry, idx) => {
      const next = labels[idx + 1]
      map.set(entry.node.id, {
        label: (entry.node as { name: string }).name,
        from: entry.line,
        to: next ? next.line - 1 : doc.nodes.length
      })
    })
    return map
  }, [doc])

  /** Bring the match on screen, without the anchor mistaking it for reading. */
  const currentLine = currentId ? (lineOf.get(currentId) ?? null) : null
  useLayoutEffect(() => {
    if (!finding || currentLine === null || !scroller.current) return
    armGuard(currentLine)
    scroller.current
      .querySelector(`[data-line="${currentLine}"]`)
      ?.scrollIntoView({ block: 'center' })
  }, [finding, currentLine])

  return (
    <div className="writer">
      {finding && (
        <FindBar
          query={query}
          onQuery={setQuery}
          total={matches.length}
          current={at}
          onStep={(delta) => setMatch(step(at, matches.length, delta))}
          onClose={() => {
            setFinding(false)
            setQuery('')
          }}
          focusNonce={findNonce}
        />
      )}
      <div className="writer-toolbar">
        <span className="wt-hint">
          <kbd>Tab</kbd> element &middot; <kbd>Enter</kbd> new line &middot; <kbd>Ctrl</kbd>+
          <kbd>B</kbd>/<kbd>I</kbd> format
        </span>
        <label className="wt-toggle">
          <input
            type="checkbox"
            checked={showCode}
            onChange={(e) => setShowCode(e.target.checked)}
          />
          <span>Show code lines</span>
        </label>
      </div>

      <div className="writer-page" ref={scroller}>
        {visible.map((node) => (
          <Fragment key={node.id}>
          <Block
            node={node}
            mark={
              finding && foundIds.has(node.id)
                ? node.id === currentId
                  ? 'current'
                  : 'found'
                : undefined
            }
            line={lineOf.get(node.id) ?? 0}
            renpyRoot={renpyRoot}
            beat={beatRange.get(node.id)}
            onBeatPass={onBeatPass}
            editing={editing?.id === node.id ? editing.field : null}
            characters={characters}
            byVar={byVar}
            labeller={labeller}
            onRevealCharacter={onRevealCharacter}
            expressionsEnabled={expressionsEnabled}
            onFocusField={focusOn}
            onBlur={stopEditing}
            onChangeNode={replaceNode}
            onEnter={insertAfter}
            onTab={cycleKind}
            onKind={setKind}
            onBackspaceEmpty={removeNode}
            onMarkup={applyMarkup}
            onSize={applySize}
            onRenameLabel={renameLabel}
            onStartBeat={startBeat}
            onAddBeat={addBeat}
            onRemoveBeat={onRemoveBeat}
            onLabelMenu={(id, at) => setLabelMenu({ id, at })}
          />
          {node.kind === 'label' && barren.has(node.id) && (
            <button className="blk-start" onClick={() => startBeat(node.id)}>
              Nothing written here yet &mdash; start the scene
            </button>
          )}
          </Fragment>
        ))}
        {visible.length === 0 && (
          <p className="writer-empty">
            This episode has nothing in it yet.{' '}
            <button className="blk-start inline" onClick={() => addBeat(null)}>
              Add the first scene
            </button>
          </p>
        )}
      </div>

      {labelMenu && (
        <ContextMenu
          at={labelMenu.at}
          items={[
            {
              label: barren.has(labelMenu.id) ? 'Start the scene' : 'Add a line at the top',
              onSelect: () => startBeat(labelMenu.id)
            },
            { label: 'New scene below', onSelect: () => addBeat(labelMenu.id) },
            { label: 'Rename', onSelect: () => focusOn(labelMenu.id, 'text', true) },
            {
              label: 'Remove scene',
              separated: true,
              disabled: !onRemoveBeat,
              onSelect: () => {
                const node = docRef.current.nodes.find((n) => n.id === labelMenu.id)
                if (node?.kind === 'label') onRemoveBeat?.(node.name)
              }
            }
          ]}
          onClose={() => setLabelMenu(null)}
        />
      )}
    </div>
  )
}

// --------------------------------------------------------------------- block

interface BlockProps {
  node: ScriptNode
  line: number
  renpyRoot: string
  /** Set on label nodes: the beat this label heads. */
  beat?: { label: string; from: number; to: number }
  onBeatPass?: (mode: PassMode, beat: { label: string; from: number; to: number }) => void
  editing: Field | null
  characters: DiscoveredCharacter[]
  byVar: Map<string, DiscoveredCharacter>
  labeller: Labeller
  onRevealCharacter?: (varName: string) => void
  expressionsEnabled: boolean
  onFocusField: (id: string, field: Field) => void
  onBlur: () => void
  onChangeNode: (id: string, updater: (n: ScriptNode) => ScriptNode) => void
  onEnter: (id: string) => void
  onRenameLabel: (id: string, typed: string) => void
  onStartBeat: (id: string) => void
  onAddBeat: (id: string | null) => void
  onRemoveBeat?: (label: string) => void
  onLabelMenu: (id: string, at: { x: number; y: number }) => void
  /** Highlight for a search hit, and for the one being looked at. */
  mark?: 'found' | 'current'
  onTab: (id: string) => void
  onKind?: (id: string, kind: ScriptNode['kind']) => void
  onBackspaceEmpty: (id: string) => void
  onMarkup: (id: string, el: HTMLTextAreaElement, kind: MarkupKind) => void
  onSize: (id: string, el: HTMLTextAreaElement, delta: number) => void
}

const Block = memo(function Block(props: BlockProps) {
  const { node, line, renpyRoot, beat, onBeatPass, editing, byVar, labeller, expressionsEnabled, onFocusField, onBlur, onChangeNode, onRevealCharacter, onRenameLabel, onStartBeat, onLabelMenu, mark } =
    props

  if (node.kind === 'blank') return <div className="blk-blank" data-line={line} />

  if (node.kind === 'raw') {
    return (
      <div className="blk-raw" data-line={line} title="Ren'Py code — edit in the Code view">
        {node.raw}
      </div>
    )
  }

  const found = mark ? ' hit-' + mark : ''

  if (node.kind === 'label') {
    return (
      <div className={'blk-label' + found} data-line={line}>
        {editing === 'text' ? (
          <input
            data-edit={`${node.id}-text`}
            className="blk-label-input"
            defaultValue={node.name}
            onBlur={(e) => {
              onRenameLabel(node.id, e.target.value)
              onBlur()
            }}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.currentTarget.blur()
                return
              }
              // Naming a scene and writing it are one movement: Enter takes
              // the name and puts the cursor on the first line.
              if (e.key === 'Enter') {
                e.preventDefault()
                onRenameLabel(node.id, e.currentTarget.value)
                onStartBeat(node.id)
              }
            }}
          />
        ) : (
          <span className="blk-label-name" onClick={() => onFocusField(node.id, 'text')}>
            {node.name}
          </span>
        )}
        <span className="blk-label-actions">
          {beat && onBeatPass && (
            <>
            <button
              className="blk-label-action"
              title={`Translate this beat (lines ${beat.from}–${beat.to})`}
              onClick={(e) => {
                e.stopPropagation()
                onBeatPass('translate', beat)
              }}
            >
              Translate
            </button>
            <button
              className="blk-label-action"
              title={`Proofread this beat (lines ${beat.from}–${beat.to})`}
              onClick={(e) => {
                e.stopPropagation()
                onBeatPass('proofread', beat)
              }}
            >
              Proofread
            </button>
            </>
          )}
          <button
            className="blk-label-action blk-label-more"
            title="What can be done with this scene"
            onClick={(e) => {
              e.stopPropagation()
              const box = e.currentTarget.getBoundingClientRect()
              onLabelMenu(node.id, { x: box.left, y: box.bottom + 4 })
            }}
          >
            &#8943;
          </button>
        </span>
      </div>
    )
  }

  if (node.kind === 'action') {
    return (
      <div className={'blk-action' + found} data-line={line}>
        <EditableText {...props} field="text" value={node.text} placeholder="Action" />
      </div>
    )
  }

  if (node.kind === 'choice') {
    return (
      <div className={'blk-choice' + found} data-line={line}>
        <span className="blk-choice-mark">&#9656;</span>
        <EditableText
          {...props}
          field="text"
          value={unescapeText(node.text)}
          placeholder="Choice"
          escapeOnSave
          rich
        />
      </div>
    )
  }

  // dialogue
  const character = node.speaker ? byVar.get(node.speaker) : undefined
  const label = node.speaker
    ? labeller(node.speaker, character)
    : { name: 'NARRATOR', variant: null }

  return (
    <div className={'blk-dialogue' + found} data-line={line}>
      <div className="blk-character">
        {editing === 'speaker' ? (
          <SpeakerInput
            nodeId={node.id}
            initial={node.speaker ?? ''}
            characters={props.characters}
            onCommit={(speaker) =>
              onChangeNode(node.id, (n) => touch(n as never, { speaker } as never))
            }
            onDone={onBlur}
            onAdvance={() => onFocusField(node.id, 'text')}
          />
        ) : (
          <span
            className={'blk-character-name' + (node.speaker ? '' : ' narrator')}
            style={{ color: readableOn(character?.color, WRITER_BG, 'var(--text)') }}
            title={
              node.speaker
                ? `${node.speaker} — Ctrl+click to open in Reference`
                : undefined
            }
            onClick={(e) => {
              // Ctrl+click looks the character up instead of editing the cue.
              if ((e.ctrlKey || e.metaKey) && node.speaker && onRevealCharacter) {
                e.preventDefault()
                onRevealCharacter(node.speaker)
                return
              }
              onFocusField(node.id, 'speaker')
            }}
          >
            {node.speaker ? label.name : 'NARRATOR'}
            {label.variant && <span className="blk-variant">{label.variant}</span>}
          </span>
        )}

        {expressionsEnabled && node.speaker && character && (
          <ExpressionPicker
            character={character}
            value={node.attributes[0] ?? ''}
            renpyRoot={renpyRoot}
            onChange={(expr) =>
              onChangeNode(node.id, (n) =>
                touch(n as never, { attributes: expr ? [expr] : [] } as never)
              )
            }
          />
        )}
      </div>

      <div className="blk-text">
        <EditableText
          {...props}
          field="text"
          value={unescapeText(node.text)}
          placeholder="Dialogue"
          escapeOnSave
          rich
        />
      </div>
    </div>
  )
})

// -------------------------------------------------------- expression picker

/** Data URLs are expensive to produce, so keep them for the session. */
const portraitCache = new Map<string, string | null>()

function usePortrait(renpyRoot: string, relPath: string | undefined): string | null {
  const [src, setSrc] = useState<string | null>(() =>
    relPath ? (portraitCache.get(renpyRoot + '|' + relPath) ?? null) : null
  )

  useEffect(() => {
    if (!relPath) {
      setSrc(null)
      return
    }
    const key = renpyRoot + '|' + relPath
    const cached = portraitCache.get(key)
    if (cached !== undefined) {
      setSrc(cached)
      return
    }
    let live = true
    void api.readPortrait(renpyRoot, relPath).then((data) => {
      portraitCache.set(key, data)
      if (live) setSrc(data)
    })
    return () => {
      live = false
    }
  }, [renpyRoot, relPath])

  return src
}

interface PickerProps {
  character: DiscoveredCharacter
  value: string
  renpyRoot: string
  onChange: (expression: string) => void
}

/**
 * Expression dropdown with a portrait preview. The preview follows whatever
 * the pointer is over, so the list can be skimmed without committing.
 */
function ExpressionPicker({ character, value, renpyRoot, onChange }: PickerProps) {
  const [open, setOpen] = useState(false)
  const [hover, setHover] = useState<string | null>(null)
  const wrap = useRef<HTMLDivElement>(null)

  const shown = hover ?? value
  const path = shown ? character.portraits[shown] : character.defaultPortrait
  const src = usePortrait(renpyRoot, path)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) {
        setOpen(false)
        setHover(null)
      }
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  /**
   * Dismiss the list and the preview together. Leaving `hover` set kept the
   * portrait on screen after a choice, since the list that would have cleared
   * it on mouse-leave was already gone.
   */
  const close = (): void => {
    setOpen(false)
    setHover(null)
  }

  const unknown = value && !character.expressions.includes(value)

  return (
    <div className="expr" ref={wrap}>
      <button
        type="button"
        className={'expr-trigger' + (unknown ? ' unknown' : '')}
        onClick={() => (open ? close() : setOpen(true))}
        onMouseEnter={() => setHover(null)}
        title={unknown ? value + ' is not defined as a side image' : 'Choose an expression'}
      >
        {value || '(none)'}
      </button>

      {(open || (src && hover !== null)) && src && (
        <div className="expr-preview">
          <img src={src} alt={shown || 'default portrait'} />
          <span>{shown || 'default'}</span>
        </div>
      )}

      {open && (
        <ul className="expr-list" onMouseLeave={() => setHover(null)}>
          <li
            className={value === '' ? 'on' : ''}
            onMouseEnter={() => setHover('')}
            onClick={() => {
              onChange('')
              close()
            }}
          >
            (none)
          </li>
          {unknown && (
            <li className="on unknown" onMouseEnter={() => setHover(value)}>
              {value} &mdash; not defined
            </li>
          )}
          {character.expressions.map((x) => (
            <li
              key={x}
              className={x === value ? 'on' : ''}
              onMouseEnter={() => setHover(x)}
              onClick={() => {
                onChange(x)
                close()
              }}
            >
              {x}
            </li>
          ))}
          {character.expressions.length === 0 && (
            <li className="empty">No side images for this character</li>
          )}
        </ul>
      )}
    </div>
  )
}

// ------------------------------------------------------------- format toolbar

interface FormatBarProps {
  onMarkup: (kind: MarkupKind) => void
  onSize: (delta: number) => void
  /** The element this line currently is, so the picker can show it. */
  kind?: ScriptNode['kind']
  onKind?: (kind: ScriptNode['kind']) => void
}

/**
 * Floating controls for the line being edited. mousedown is suppressed so the
 * textarea keeps focus and its selection while a button is pressed.
 */
const ELEMENT_NAMES: Record<string, string> = {
  dialogue: 'Dialogue',
  action: 'Action'
}

function FormatBar({ onMarkup, onSize, kind, onKind }: FormatBarProps) {
  const hold = (fn: () => void) => (e: ReactMouseEvent) => {
    e.preventDefault()
    fn()
  }
  return (
    <div className="fmt-bar" onMouseDown={(e) => e.preventDefault()}>
      {/*
        Named buttons rather than only the Tab key: a phone has no Tab, and
        even on a desktop cycling through three states to reach one of them is
        a worse way to say what you mean.
      */}
      {kind && onKind && (
        <span className="fmt-kinds">
          {CYCLE.map((k) => (
            <button
              key={k}
              type="button"
              className={'fmt-kind' + (k === kind ? ' on' : '')}
              title={`Make this ${ELEMENT_NAMES[k]} (Tab cycles)`}
              onMouseDown={hold(() => onKind(k))}
            >
              {ELEMENT_NAMES[k]}
            </button>
          ))}
        </span>
      )}
      <button type="button" title="Bold (Ctrl+B)" onMouseDown={hold(() => onMarkup('bold'))}>
        <b>B</b>
      </button>
      <button type="button" title="Italic (Ctrl+I)" onMouseDown={hold(() => onMarkup('italic'))}>
        <i>I</i>
      </button>
      <span className="fmt-sep" />
      <button type="button" title="Smaller" onMouseDown={hold(() => onSize(-2))}>
        A&minus;
      </button>
      <button type="button" title="Larger" onMouseDown={hold(() => onSize(2))}>
        A+
      </button>
    </div>
  )
}

// --------------------------------------------------------- markup rendering

/** Opening tags carry a value ({size=+4}); closing tags never do ({/size}). */
const TAG_RE = /\{(\/)?(b|i|u|s|size(?:=[+-]?\d+)?)\}/g

const BASE_FONT_PX = 14

function styleFor(tags: string[]): CSSProperties {
  const style: CSSProperties = {}
  const decorations: string[] = []
  for (const tag of tags) {
    if (tag === 'b') style.fontWeight = 700
    else if (tag === 'i') style.fontStyle = 'italic'
    else if (tag === 'u') decorations.push('underline')
    else if (tag === 's') decorations.push('line-through')
    else if (tag.startsWith('size=')) {
      const delta = Number(tag.slice(5))
      if (Number.isFinite(delta)) style.fontSize = `${Math.max(8, BASE_FONT_PX + delta)}px`
    }
  }
  if (decorations.length) style.textDecoration = decorations.join(' ')
  return style
}

/**
 * Render Ren'Py inline markup as actual styling, so bold looks bold instead of
 * showing its tags. Anything we do not recognise is left as literal text --
 * the game engine has many more tags than the writer needs to understand.
 */
function renderMarkup(text: string): ReactNode {
  const out: ReactNode[] = []
  const open: string[] = []
  let last = 0
  let key = 0

  const emit = (chunk: string): void => {
    if (!chunk) return
    if (open.length === 0) out.push(chunk)
    else out.push(
      <span key={key++} style={styleFor(open)}>
        {chunk}
      </span>
    )
  }

  TAG_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = TAG_RE.exec(text)) !== null) {
    emit(text.slice(last, m.index))
    const name = m[2]
    if (m[1]) {
      // Closing: drop the most recent matching tag, ignoring any =value.
      for (let i = open.length - 1; i >= 0; i--) {
        if (open[i].split('=')[0] === name.split('=')[0]) {
          open.splice(i, 1)
          break
        }
      }
    } else {
      open.push(name)
    }
    last = TAG_RE.lastIndex
  }
  emit(text.slice(last))
  return out
}

// ------------------------------------------------------------ editable text

interface EditableProps extends BlockProps {
  field: Field
  value: string
  placeholder: string
  escapeOnSave?: boolean
  /** Render Ren'Py inline markup as styling in the read-only view. */
  rich?: boolean
}

function EditableText({
  node,
  editing,
  field,
  value,
  placeholder,
  escapeOnSave,
  rich,
  onFocusField,
  onSize,
  onBlur,
  onChangeNode,
  onEnter,
  onTab,
  onKind,
  onBackspaceEmpty,
  onMarkup
}: EditableProps) {
  const ref = useRef<HTMLTextAreaElement>(null)

  // Grow to fit rather than scrolling inside a fixed box.
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  })

  if (editing !== field) {
    return (
      <span
        className={'blk-view' + (value ? '' : ' empty')}
        onClick={() => onFocusField(node.id, field)}
      >
        {value ? (rich ? renderMarkup(value) : value) : placeholder}
      </span>
    )
  }

  const showFormatting = node.kind === 'dialogue' || node.kind === 'choice'

  return (
    <div className="blk-edit">
      {showFormatting && (
        <FormatBar
          kind={CYCLE.includes(node.kind) ? node.kind : undefined}
          onKind={CYCLE.includes(node.kind) ? (next) => onKind?.(node.id, next) : undefined}
          onMarkup={(kind) => ref.current && onMarkup(node.id, ref.current, kind)}
          onSize={(delta) => ref.current && onSize(node.id, ref.current, delta)}
        />
      )}
      <textarea
        ref={ref}
        data-edit={`${node.id}-${field}`}
      className="blk-input"
      rows={1}
      defaultValue={value}
      placeholder={placeholder}
      onBlur={(e) => {
        const raw = e.target.value.replace(/\s*\n\s*/g, ' ')
        const text = escapeOnSave ? escapeText(raw) : raw
        onChangeNode(node.id, (n) => touch(n as never, { text } as never))
        onBlur()
      }}
      onInput={(e) => {
        const el = e.currentTarget
        el.style.height = 'auto'
        el.style.height = `${el.scrollHeight}px`
      }}
      onKeyDown={(e) => {
        const el = e.currentTarget
        if (e.key === 'Enter' && !e.shiftKey) {
          // Never insert a newline: one dialogue line is one .rpy line.
          e.preventDefault()
          el.blur()
          onEnter(node.id)
        } else if (e.key === 'Tab') {
          e.preventDefault()
          el.blur()
          onTab(node.id)
        } else if (e.key === 'Backspace' && el.value === '' && el.selectionStart === 0) {
          e.preventDefault()
          el.blur()
          onBackspaceEmpty(node.id)
        } else if ((e.ctrlKey || e.metaKey) && !e.shiftKey) {
          const k = e.key.toLowerCase()
          if (k === 'b' || k === 'i') {
            e.preventDefault()
            onMarkup(node.id, el, k === 'b' ? 'bold' : 'italic')
          }
          } else if (e.key === 'Escape') {
            el.blur()
          }
        }}
      />
    </div>
  )
}

// ----------------------------------------------------------- speaker input

interface SpeakerProps {
  nodeId: string
  initial: string
  characters: DiscoveredCharacter[]
  onCommit: (speaker: string | null) => void
  onDone: () => void
  onAdvance: () => void
}

/**
 * Character field with prefix completion. Tab completes to the highlighted
 * suggestion and stays put; Tab again (with nothing left to complete) moves on
 * to the dialogue, which is the screenplay-editor rhythm.
 */
function SpeakerInput({ nodeId, initial, characters, onCommit, onDone, onAdvance }: SpeakerProps) {
  const [query, setQuery] = useState(initial)
  const [active, setActive] = useState(0)
  const committed = useRef(false)

  const matches = useMemo(() => matchSpeakers(characters, query), [characters, query])

  const exact = matches.length === 1 && matches[0].varName.toLowerCase() === query.trim().toLowerCase()

  function commit(value: string) {
    if (committed.current) return
    committed.current = true
    onCommit(value.trim() || null)
  }

  return (
    <div className="speaker-wrap">
      <input
        autoFocus
        data-edit={`${nodeId}-speaker`}
        className="blk-character-input"
        value={query}
        placeholder="character"
        spellCheck={false}
        onChange={(e) => {
          setQuery(e.target.value)
          setActive(0)
        }}
        onBlur={() => {
          commit(query)
          onDone()
        }}
        onKeyDown={(e) => {
          if (e.key === 'Tab') {
            e.preventDefault()
            const pick = matches[active]
            if (pick && !exact) {
              // Complete first; only move on once there is nothing to complete.
              setQuery(pick.varName)
              setActive(0)
              return
            }
            commit(query)
            onDone()
            onAdvance()
          } else if (e.key === 'Enter') {
            e.preventDefault()
            const pick = matches[active]
            commit(pick && !exact ? pick.varName : query)
            onDone()
            onAdvance()
          } else if (e.key === 'ArrowDown') {
            e.preventDefault()
            setActive((i) => Math.min(i + 1, Math.max(matches.length - 1, 0)))
          } else if (e.key === 'ArrowUp') {
            e.preventDefault()
            setActive((i) => Math.max(i - 1, 0))
          } else if (e.key === 'Escape') {
            e.currentTarget.blur()
          }
        }}
      />

      {matches.length > 0 && !exact && (
        <ul className="speaker-suggest">
          {matches.map((c, i) => (
            <li
              key={c.varName}
              className={i === active ? 'on' : ''}
              onMouseDown={(e) => {
                e.preventDefault()
                commit(c.varName)
                onDone()
                onAdvance()
              }}
            >
              <span className="ss-var">{c.varName}</span>
              <span className="ss-name">{c.name}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

