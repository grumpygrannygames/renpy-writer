import { hoverTooltip, type Tooltip } from '@codemirror/view'
import type { EditorView } from '@codemirror/view'

export interface ImageLookup {
  dataUrl: string | null
  matched?: string
  kind?: 'image' | 'video' | 'color'
  color?: string
  reason?: string
}

/** Words after `scene`/`show` that end the image name and start options. */
const STOP = /^(with|at|as|behind|onlayer|zorder|if|and)$/

/** `    scene ch9_diner_1 with Fade(1, 1, 2)` */
const STATEMENT_RE = /^(\s*)(scene|show)\s+/

interface NameSpan {
  name: string
  from: number
  to: number
}

/** Pull the image name and its span out of a scene/show line. */
export function imageNameAt(lineText: string, lineStart: number, pos: number): NameSpan | null {
  const head = lineText.match(STATEMENT_RE)
  if (!head) return null

  let cursor = head[0].length
  const from = lineStart + cursor
  const words: string[] = []
  let end = cursor

  while (cursor < lineText.length) {
    const rest = lineText.slice(cursor)
    const ws = rest.match(/^\s+/)
    if (ws) {
      cursor += ws[0].length
      continue
    }
    const word = rest.match(/^[A-Za-z0-9_]+/)
    if (!word) break
    if (STOP.test(word[0])) break
    words.push(word[0])
    cursor += word[0].length
    end = cursor
  }

  if (words.length === 0) return null
  const to = lineStart + end
  // Only offer a preview when the pointer is actually over the name.
  if (pos < from || pos > to) return null
  return { name: words.join(' '), from, to }
}

function box(): HTMLElement {
  const dom = document.createElement('div')
  dom.className = 'img-tip'
  return dom
}

/**
 * Preview the image a `scene` or `show` refers to, on hover.
 *
 * A name with no match usually means the render has not been made yet, which
 * is worth showing rather than hiding: an empty preview is a missing asset.
 */
export function imageHover(lookup: (name: string) => Promise<ImageLookup | null>) {
  return hoverTooltip(async (view: EditorView, pos: number): Promise<Tooltip | null> => {
    const line = view.state.doc.lineAt(pos)
    const span = imageNameAt(line.text, line.from, pos)
    if (!span) return null

    let result: ImageLookup | null = null
    try {
      result = await lookup(span.name)
    } catch {
      return null
    }
    if (!result) return null

    return {
      pos: span.from,
      end: span.to,
      above: true,
      create: () => {
        const dom = box()

        if (result.dataUrl) {
          const img = document.createElement('img')
          img.src = result.dataUrl
          img.alt = span.name
          dom.appendChild(img)
        } else if (result.kind === 'color' && result.color) {
          const swatch = document.createElement('div')
          swatch.className = 'img-tip-swatch'
          swatch.style.background = result.color
          dom.appendChild(swatch)
        } else if (result.kind === 'video') {
          const note = document.createElement('div')
          note.className = 'img-tip-note'
          note.textContent = 'Video: ' + (result.reason ?? span.name)
          dom.appendChild(note)
        } else {
          const note = document.createElement('div')
          note.className = 'img-tip-note missing'
          note.textContent = result.reason ?? 'No image file found'
          dom.appendChild(note)
        }

        const caption = document.createElement('div')
        caption.className = 'img-tip-caption'
        caption.textContent =
          result.matched && result.matched !== span.name
            ? `${span.name} → ${result.matched}`
            : span.name
        dom.appendChild(caption)

        return { dom }
      }
    }
  }, { hoverTime: 250 })
}
