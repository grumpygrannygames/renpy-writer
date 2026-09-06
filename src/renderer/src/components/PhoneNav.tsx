export type Pane = 'outline' | 'script' | 'notes'

/**
 * The bar along the bottom of a phone.
 *
 * One pane at a time, reachable with a thumb. Sync is a button rather than a
 * pane because it is something you do and then leave, not somewhere you work.
 */
export default function PhoneNav({
  pane,
  onPane,
  onSync,
  pending
}: {
  pane: Pane
  onPane: (pane: Pane) => void
  onSync: () => void
  /** Unsent or unsaved changes, shown as a dot so it needs no words. */
  pending: boolean
}) {
  const tab = (id: Pane, label: string, glyph: string) => (
    <button
      key={id}
      className={'pn-tab' + (pane === id ? ' on' : '')}
      onClick={() => onPane(id)}
      aria-current={pane === id}
    >
      <span className="pn-glyph" aria-hidden="true">
        {glyph}
      </span>
      <span className="pn-label">{label}</span>
    </button>
  )

  return (
    <nav className="phone-nav">
      {tab('outline', 'Outline', '☰')}
      {tab('script', 'Script', '¶')}
      {tab('notes', 'Notes', '★')}
      <button className="pn-tab" onClick={onSync}>
        <span className="pn-glyph" aria-hidden="true">
          ⇅
        </span>
        <span className="pn-label">Sync</span>
        {pending && <span className="pn-dot" aria-label="unsent changes" />}
      </button>
    </nav>
  )
}
