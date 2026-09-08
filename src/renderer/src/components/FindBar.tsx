import { useEffect, useRef } from 'react'

/**
 * Find, in whichever view is on screen.
 *
 * Floats over the editor rather than sitting above it, so opening it does not
 * reflow the page and lose the reader's place -- which is the one thing a
 * search is not allowed to do.
 */
export default function FindBar({
  query,
  onQuery,
  total,
  current,
  onStep,
  onClose,
  focusNonce
}: {
  query: string
  onQuery: (value: string) => void
  total: number
  /** 0-based position among the matches, or -1 for none. */
  current: number
  onStep: (delta: number) => void
  onClose: () => void
  /** Bumped each time Ctrl+F is pressed, to take the field back. */
  focusNonce: number
}) {
  const input = useRef<HTMLInputElement>(null)

  // Pressing Ctrl+F with the bar already open should select what is in it,
  // the way it does everywhere else.
  useEffect(() => {
    input.current?.focus()
    input.current?.select()
  }, [focusNonce])

  const none = query.trim().length > 0 && total === 0

  return (
    <div className="find-bar" onKeyDown={(e) => e.stopPropagation()}>
      <input
        ref={input}
        className={'find-input' + (none ? ' none' : '')}
        value={query}
        placeholder="Find"
        onChange={(e) => onQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            onStep(e.shiftKey ? -1 : 1)
          } else if (e.key === 'Escape') {
            e.preventDefault()
            onClose()
          }
        }}
      />
      <span className="find-count">
        {query.trim().length === 0 ? '' : total === 0 ? 'None' : `${current + 1} of ${total}`}
      </span>
      <button className="find-step" title="Previous (Shift+Enter)" onClick={() => onStep(-1)}>
        &uarr;
      </button>
      <button className="find-step" title="Next (Enter)" onClick={() => onStep(1)}>
        &darr;
      </button>
      <button className="find-step" title="Close (Esc)" onClick={onClose}>
        &times;
      </button>
    </div>
  )
}
