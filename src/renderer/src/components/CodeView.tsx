import { useEffect, useMemo, useRef, useState } from 'react'
import { EditorState } from '@codemirror/state'
import { EditorView, keymap, lineNumbers, highlightActiveLine } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { renpySetup } from '../renpyMode'
import { imageHover, type ImageLookup } from '../imageHover'
import FindBar from './FindBar'
import { offsetsIn, step } from '../find'

interface Props {
  /** Identifies the document; changing it rebuilds the editor. */
  docKey: string
  value: string
  onChange: (value: string) => void
  onSave: () => void
  /** 1-indexed line to reveal, e.g. when a beat is clicked in the outline. */
  revealLine?: number | null
  /**
   * Reports the line at the vertical centre of the viewport, which is what
   * Writer <-> Code switching uses to keep your reading position.
   */
  onAnchorLine?: (line: number) => void
  /** Looks up a scene/show image name for the hover preview. */
  onLookupImage?: (name: string) => Promise<ImageLookup | null>
}

/**
 * The code view is a plain CodeMirror editor over the real .rpy text. It is
 * intentionally the unfiltered file: whatever the writer view cannot yet
 * express is always reachable and editable here.
 */
export default function CodeView({
  docKey,
  value,
  onChange,
  onSave,
  revealLine,
  onAnchorLine,
  onLookupImage
}: Props) {
  const host = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView | null>(null)
  const [finding, setFinding] = useState(false)
  const [query, setQuery] = useState('')
  const [match, setMatch] = useState(0)
  const [findNonce, setFindNonce] = useState(0)
  // Kept in refs so the editor is never rebuilt just because a callback changed.
  const onChangeRef = useRef(onChange)
  const onSaveRef = useRef(onSave)
  const onAnchorLineRef = useRef(onAnchorLine)
  const onLookupImageRef = useRef(onLookupImage)
  /** Recomputes the anchor; set once the editor exists. */
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

  onChangeRef.current = onChange
  onSaveRef.current = onSave
  onAnchorLineRef.current = onAnchorLine
  onLookupImageRef.current = onLookupImage

  useEffect(() => {
    if (!host.current) return

    const state = EditorState.create({
      doc: value,
      extensions: [
        lineNumbers(),
        history(),
        highlightActiveLine(),
        keymap.of([
          {
            key: 'Mod-s',
            preventDefault: true,
            run: () => {
              onSaveRef.current()
              return true
            }
          },
          indentWithTab,
          ...defaultKeymap,
          ...historyKeymap
        ]),
        renpySetup,
        imageHover((name) => onLookupImageRef.current?.(name) ?? Promise.resolve(null)),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) onChangeRef.current(u.state.doc.toString())
        })
      ]
    })

    const v = new EditorView({ state, parent: host.current })
    view.current = v

    // The line under the middle of the viewport, recomputed on scroll.
    // Throttled with a timer rather than requestAnimationFrame, which Chromium
    // throttles hard once the window is hidden or minimised.
    let timer = 0
    const report = (): void => {
      timer = 0
      const middle = v.scrollDOM.scrollTop + v.scrollDOM.clientHeight / 2
      const block = v.lineBlockAtHeight(middle)
      const line = v.state.doc.lineAt(block.from).number

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
    // A real gesture means the reader has taken over; stop waiting for the
    // programmatic scroll to land.
    const release = (): void => armGuard(null)
    v.scrollDOM.addEventListener('scroll', onScroll, { passive: true })
    v.scrollDOM.addEventListener('wheel', release, { passive: true })
    v.scrollDOM.addEventListener('pointerdown', release, { passive: true })
    reportRef.current = report
    // Arm before the first report so mounting at the top of the file cannot
    // clobber the anchor a pending reveal is about to restore.
    armGuard(revealRef.current ?? null)
    report()

    return () => {
      v.scrollDOM.removeEventListener('scroll', onScroll)
      v.scrollDOM.removeEventListener('wheel', release)
      v.scrollDOM.removeEventListener('pointerdown', release)
      if (guardTimer.current) clearTimeout(guardTimer.current)
      if (timer) clearTimeout(timer)
      reportRef.current = null
      v.destroy()
      view.current = null
    }
    // Rebuilt only when the open document changes, not on every keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docKey])

  useEffect(() => {
    const v = view.current
    if (!v || !revealLine) return
    const total = v.state.doc.lines
    const clamped = Math.min(Math.max(revealLine, 1), total)
    armGuard(clamped)
    const line = v.state.doc.line(clamped)
    v.dispatch({
      selection: { anchor: line.from },
      effects: EditorView.scrollIntoView(line.from, { y: 'center' })
    })

    // CodeMirror applies the scroll in its own measure pass, which can be well
    // after this effect. Recompute a few times as it settles instead of
    // trusting a single moment.
    const timers = [80, 250, 600].map((ms) =>
      window.setTimeout(() => reportRef.current?.(), ms)
    )
    return () => timers.forEach(clearTimeout)
  }, [revealLine, docKey])

  /**
   * Matched here rather than with CodeMirror's own search panel, so that
   * finding something works and looks the same in both views. A panel that
   * appears in one of them and not the other is worse than a plain one that
   * appears in both.
   */
  const matches = useMemo(() => offsetsIn(value, query), [value, query])
  const at = matches.length > 0 ? Math.min(match, matches.length - 1) : -1

  // A new search starts at the top of it.
  useEffect(() => setMatch(0), [query])

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

  // Select the match and bring it into view. Selecting rather than only
  // scrolling means the caret is already there when the bar is closed.
  useEffect(() => {
    const v = view.current
    if (!finding || !v || at < 0) return
    const from = matches[at]
    const to = Math.min(from + query.length, v.state.doc.length)
    armGuard(v.state.doc.lineAt(from).number)
    v.dispatch({
      selection: { anchor: from, head: to },
      effects: EditorView.scrollIntoView(from, { y: 'center' })
    })
    const timers = [80, 250].map((ms) => window.setTimeout(() => reportRef.current?.(), ms))
    return () => timers.forEach(clearTimeout)
    // `matches` is derived from the same text the editor holds.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [finding, at, matches, query.length])

  return (
    <>
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
            view.current?.focus()
          }}
          focusNonce={findNonce}
        />
      )}
      <div className="cm-host" ref={host} />
    </>
  )
}
