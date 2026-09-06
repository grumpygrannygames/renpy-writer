import { useEffect, useState } from 'react'

/**
 * Whether to lay the app out as a phone: one pane at a time, with a bar of
 * tabs along the bottom.
 *
 * Decided by width rather than by user agent, so a narrow desktop window gets
 * the same treatment and the layout can be checked without a phone in hand.
 * 820px sits above a large phone in landscape and below a small tablet, which
 * is where three columns stop fitting.
 */
const PHONE = '(max-width: 820px)'

export function usePhoneLayout(): boolean {
  const [phone, setPhone] = useState(
    () => typeof window !== 'undefined' && window.matchMedia(PHONE).matches
  )

  useEffect(() => {
    const query = window.matchMedia(PHONE)
    const update = (): void => setPhone(query.matches)
    update()
    query.addEventListener('change', update)
    return () => query.removeEventListener('change', update)
  }, [])

  return phone
}
