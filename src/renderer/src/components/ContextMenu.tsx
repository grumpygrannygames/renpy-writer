import { useEffect, useLayoutEffect, useRef, useState } from 'react'

export interface MenuItem {
  label: string
  onSelect: () => void
  disabled?: boolean
  /** Draws a divider above this item. */
  separated?: boolean
}

export interface MenuPosition {
  x: number
  y: number
}

/**
 * A right-click menu placed at the pointer, nudged back on screen when it
 * would overflow. Closes on any outside click, Escape, scroll or resize, so it
 * can never be left stranded over content that moved.
 */
export default function ContextMenu({
  at,
  items,
  onClose
}: {
  at: MenuPosition
  items: MenuItem[]
  onClose: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState(at)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const box = el.getBoundingClientRect()
    setPos({
      x: Math.min(at.x, window.innerWidth - box.width - 8),
      y: Math.min(at.y, window.innerHeight - box.height - 8)
    })
  }, [at])

  useEffect(() => {
    const close = (): void => onClose()
    /**
     * Capture phase runs before React's own handlers, so this must ignore
     * presses inside the menu. Closing on them would unmount the button before
     * its click could land, and the item would silently do nothing.
     */
    const onDown = (e: MouseEvent): void => {
      if (!ref.current?.contains(e.target as Node)) onClose()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('mousedown', onDown, true)
    document.addEventListener('keydown', onKey)
    window.addEventListener('resize', close)
    window.addEventListener('scroll', close, true)
    return () => {
      document.removeEventListener('mousedown', onDown, true)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('resize', close)
      window.removeEventListener('scroll', close, true)
    }
  }, [onClose])

  return (
    <div
      className="ctxmenu"
      ref={ref}
      style={{ left: pos.x, top: pos.y }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((item, i) => (
        <button
          key={i}
          className={'ctx-item' + (item.separated ? ' separated' : '')}
          disabled={item.disabled}
          onClick={() => {
            onClose()
            item.onSelect()
          }}
        >
          {item.label}
        </button>
      ))}
    </div>
  )
}
