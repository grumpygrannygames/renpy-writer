import {
  HighlightStyle,
  StreamLanguage,
  indentUnit,
  syntaxHighlighting
} from '@codemirror/language'
import { EditorState } from '@codemirror/state'
import { tags as t } from '@lezer/highlight'
import { EditorView } from '@codemirror/view'

/** Statement keywords that open or terminate a block. */
const CONTROL = new Set([
  'label',
  'jump',
  'call',
  'return',
  'menu',
  'if',
  'elif',
  'else',
  'while',
  'pass'
])

/** Presentation statements. */
const STAGE = new Set([
  'scene',
  'show',
  'hide',
  'play',
  'stop',
  'queue',
  'pause',
  'window',
  'nvl',
  'voice',
  'with',
  'at',
  'as',
  'behind',
  'onlayer',
  'zorder',
  'expression',
  'loop',
  'fadein',
  'fadeout',
  'volume',
  'music',
  'sound'
])

/** Declarations. */
const DECL = new Set(['define', 'default', 'image', 'transform', 'screen', 'init', 'python', 'style'])

/**
 * A stream tokenizer for Ren'Py. Deliberately shallow: this powers the code
 * view, while structural understanding lives in the parser in the main
 * process. Anything it does not recognise simply renders as plain text.
 */
export const renpyLanguage = StreamLanguage.define<{ inString: boolean }>({
  name: 'renpy',

  startState() {
    return { inString: false }
  },

  token(stream, state) {
    if (state.inString) {
      while (!stream.eol()) {
        const ch = stream.next()
        if (ch === '\\') {
          stream.next()
          continue
        }
        if (ch === '"') {
          state.inString = false
          return t.string.toString()
        }
      }
      return t.string.toString()
    }

    if (stream.eatSpace()) return null

    if (stream.peek() === '#') {
      stream.skipToEnd()
      return 'comment'
    }

    if (stream.peek() === '"') {
      stream.next()
      state.inString = true
      while (!stream.eol()) {
        const ch = stream.next()
        if (ch === '\\') {
          stream.next()
          continue
        }
        if (ch === '"') {
          state.inString = false
          break
        }
      }
      return 'string'
    }

    if (stream.match(/^\$/)) return 'operator'

    if (stream.match(/^\d+(\.\d+)?/)) return 'number'

    // StringStream.match returns boolean | RegExpMatchArray depending on the
    // pattern, so narrow before indexing.
    const word = stream.match(/^[A-Za-z_]\w*/)
    if (word && typeof word !== 'boolean') {
      const w = word[0]
      if (CONTROL.has(w)) return 'controlKeyword'
      if (STAGE.has(w)) return 'keyword'
      if (DECL.has(w)) return 'definitionKeyword'
      return 'variableName'
    }

    stream.next()
    return null
  },

  languageData: {
    commentTokens: { line: '#' },
    indentOnInput: /^\s*(else|elif)\b/
  }
})

const highlight = HighlightStyle.define([
  { tag: t.comment, color: '#6a6a78', fontStyle: 'italic' },
  { tag: t.string, color: '#c8e58c' },
  { tag: t.number, color: '#e0a44a' },
  { tag: t.operator, color: '#e05a9c' },
  { tag: t.controlKeyword, color: '#e05a9c', fontWeight: '600' },
  { tag: t.keyword, color: '#7c9cff' },
  { tag: t.definitionKeyword, color: '#57b6c2' },
  { tag: t.variableName, color: '#e6e6ea' }
])

const theme = EditorView.theme(
  {
    '&': { color: '#e6e6ea', backgroundColor: '#16161a', height: '100%' },
    '.cm-content': { caretColor: '#7c6cff' },
    '.cm-cursor, .cm-dropCursor': { borderLeftColor: '#7c6cff' },
    '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
      backgroundColor: '#33334a'
    },
    '.cm-gutters': {
      backgroundColor: '#1c1c21',
      color: '#5a5a68',
      border: 'none',
      borderRight: '1px solid #32323c'
    },
    '.cm-activeLine': { backgroundColor: '#1e1e25' },
    '.cm-activeLineGutter': { backgroundColor: '#24242b', color: '#9a9aa8' }
  },
  { dark: true }
)

/**
 * Four spaces to a level, and never a tab.
 *
 * Not a preference to be set per project: Ren'Py refuses a script with a
 * tab character in it outright -- "Tab characters are not allowed in Ren'Py
 * scripts" -- and four is what every script it ships uses, from the new
 * project template to the launcher's own source, without exception. The
 * editor's own default is two, which is how Tab came to disagree with every
 * other line the app writes.
 *
 * tabSize only says how wide a tab is drawn. Nothing here makes one, but a
 * file that arrived with one should not look narrower than it reads.
 */
const INDENT = '    '

const indentation = [indentUnit.of(INDENT), EditorState.tabSize.of(4)]

/**
 * A pasted tab becomes spaces on the way in.
 *
 * The Tab key cannot make one any more, but a paste still can, and a tab is
 * not a style the file gets to have: Ren'Py refuses to load the script, at
 * the point of running the game rather than here. Somebody pasting a scene
 * from another editor would find out much later, and about a character they
 * cannot see.
 *
 * Every tab, not only the ones at the start of a line. Indentation is the
 * only place a tab means anything, but a tab further along the line is just
 * as fatal -- and one inside a string, which Ren'Py does allow, is a tab
 * nobody can see in dialogue and almost certainly did not want.
 */
const spacesOnPaste = EditorView.domEventHandlers({
  paste(event, view) {
    const pasted = event.clipboardData?.getData('text/plain')
    if (!pasted || !pasted.includes('\t')) return false
    event.preventDefault()
    view.dispatch({
      ...view.state.replaceSelection(pasted.replaceAll('\t', INDENT)),
      scrollIntoView: true,
      userEvent: 'input.paste'
    })
    return true
  }
})

export const renpySetup = [
  renpyLanguage,
  syntaxHighlighting(highlight),
  theme,
  indentation,
  spacesOnPaste
]
