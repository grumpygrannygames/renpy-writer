import { useEffect, useRef, useState } from 'react'
import type { FreeNote, LocationNote } from '@shared/types'
import { useStore } from '../state/store'
import { newId, useCast } from '../useCast'
import { type RefTarget } from '../wikiLink'
import { LinkedField } from './CharacterFields'
import AddCharacterDialog from './AddCharacterDialog'

type Section = 'characters' | 'locations' | 'notes'

/**
 * Reference material: the cast, places and free notes. None of this reaches
 * the game; it exists so facts can be looked up while writing.
 */
export default function ReferencePanel({
  onClose,
  focusRequest,
  className,
  hideClose,
  onOpenedInEditor
}: {
  onClose: () => void
  /** Extra classes from the shell, used to show or hide this as a pane. */
  className?: string
  /** A phone reaches this from the bar below, so it needs no close button. */
  hideClose?: boolean
  /** Called when a character was opened in the editor, so a phone can go there. */
  onOpenedInEditor?: () => void
  /**
   * One-shot request to reveal a script variable, e.g. from a Ctrl+click in the
   * writer. The nonce makes each request distinct so asking for the same
   * character twice still works.
   */
  focusRequest?: { varName: string; nonce: number } | null
}) {
  const opened = useStore((s) => s.opened)
  const reference = useStore((s) => s.reference)
  const upsertCharacterNote = useStore((s) => s.upsertCharacterNote)
  const upsertLocation = useStore((s) => s.upsertLocation)
  const upsertNote = useStore((s) => s.upsertNote)
  const removeReferenceItem = useStore((s) => s.removeReferenceItem)
  const openCharacterTab = useStore((s) => s.openCharacterTab)

  const setCharacterOrder = useStore((s) => s.setCharacterOrder)
  const { profiles, unassigned, linkIndex, profileForVar } = useCast()

  const [section, setSection] = useState<Section>('characters')
  const [selected, setSelected] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [adding, setAdding] = useState<{ preselect?: string } | null>(null)
  const [dragging, setDragging] = useState<string | null>(null)
  const [dragOver, setDragOver] = useState<string | null>(null)

  // A Ctrl+click in the writer names a script variable, not a profile.
  //
  // Deliberately keyed on the nonce alone. The lookup map is rebuilt whenever
  // reference data changes, so depending on it re-ran this on every field edit
  // and yanked the open tab back to whoever was last focused.
  const latest = useRef({ profileForVar, openCharacterTab })
  latest.current = { profileForVar, openCharacterTab }
  const handled = useRef<number | null>(null)

  useEffect(() => {
    if (!focusRequest || handled.current === focusRequest.nonce) return
    handled.current = focusRequest.nonce
    setSection('characters')
    setQuery('')
    const owner = latest.current.profileForVar.get(focusRequest.varName)
    if (owner) latest.current.openCharacterTab(owner.note.id, owner.note.name)
    else setSelected('unassigned:' + focusRequest.varName)
  }, [focusRequest])

  function follow(target: RefTarget): void {
    setSection(
      target.kind === 'character' ? 'characters' : target.kind === 'location' ? 'locations' : 'notes'
    )
    setSelected(target.id)
    setQuery('')
  }

  const q = query.trim().toLowerCase()
  const keep = (text: string): boolean => !q || text.toLowerCase().includes(q)

  /** Move `id` to sit where `target` currently is. */
  function moveProfile(id: string, target: string): void {
    const ids = profiles.map((p) => p.note.id)
    const from = ids.indexOf(id)
    const to = ids.indexOf(target)
    if (from === -1 || to === -1) return
    ids.splice(to, 0, ...ids.splice(from, 1))
    setCharacterOrder(ids)
  }

  if (!opened) return null

  return (
    <aside className={'refpanel' + (className ?? '')}>
      <div className="ref-head">
        <div className="ref-tabs">
          {(['characters', 'locations', 'notes'] as Section[]).map((s) => (
            <button
              key={s}
              className={section === s ? 'on' : ''}
              onClick={() => {
                setSection(s)
                setSelected(null)
              }}
            >
              {s === 'characters' ? 'Characters' : s === 'locations' ? 'Locations' : 'Notes'}
            </button>
          ))}
        </div>
        {!hideClose && (
          <button className="ghost" title="Hide reference panel" onClick={onClose}>
            &times;
          </button>
        )}
      </div>

      <div className="ref-search">
        <input
          value={query}
          placeholder={`Search ${section}`}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      <div className="ref-body">
        {section === 'characters' && (
          <>
            <div className="ref-actions">
              <button onClick={() => setAdding({})}>Add character</button>
            </div>

            <ul className="ref-list">
              {profiles
                .filter((p) => keep(p.note.name + ' ' + p.note.varNames.join(' ')))
                .map((p) => (
                  <li
                    key={p.note.id}
                    className={
                      'draggable' +
                      (dragOver === p.note.id ? ' dragover' : '') +
                      (dragging === p.note.id ? ' dragging' : '')
                    }
                    // Opening full size is the default: the panel is for finding
                    // a character, the tab is for writing about them.
                    onClick={() => {
                      openCharacterTab(p.note.id, p.note.name)
                      onOpenedInEditor?.()
                    }}
                    onDragOver={(e) => {
                      if (!dragging) return
                      e.preventDefault()
                      setDragOver(p.note.id)
                    }}
                    onDragLeave={() => setDragOver((d) => (d === p.note.id ? null : d))}
                    onDrop={(e) => {
                      e.preventDefault()
                      if (dragging && dragging !== p.note.id) moveProfile(dragging, p.note.id)
                      setDragging(null)
                      setDragOver(null)
                    }}
                  >
                    <span
                      className="rl-grip"
                      title="Drag to reorder"
                      draggable
                      onClick={(e) => e.stopPropagation()}
                      onDragStart={(e) => {
                        e.stopPropagation()
                        e.dataTransfer.effectAllowed = 'move'
                        setDragging(p.note.id)
                      }}
                      onDragEnd={() => {
                        setDragging(null)
                        setDragOver(null)
                      }}
                    >
                      &#9776;
                    </span>
                    <span className="rl-name">{p.note.name}</span>
                    {p.note.varNames.length > 0 && (
                      <span className="rl-var">
                        {p.note.varNames.length === 1
                          ? p.note.varNames[0]
                          : p.note.varNames.length + ' vars'}
                      </span>
                    )}
                    {p.note.accent && <span className="rl-tag">{p.note.accent}</span>}
                  </li>
                ))}
              {profiles.length === 0 && (
                <li className="ref-empty">
                  No character profiles yet. Add one and pick the script variables it covers.
                </li>
              )}
            </ul>

            {unassigned.length > 0 && (
              <div className="ref-unassigned">
                <div className="ru-head">In the script, no profile yet ({unassigned.length})</div>
                <ul className="ref-list">
                  {unassigned
                    .filter((c) => keep(c.name + ' ' + c.varName))
                    .map((c) => (
                      <li
                        key={c.varName}
                        className={selected === 'unassigned:' + c.varName ? 'on' : ''}
                        title={'Create a profile for ' + c.varName}
                        onClick={() => setAdding({ preselect: c.varName })}
                      >
                        <span className="rl-name">{c.name}</span>
                        <span className="rl-var">{c.varName}</span>
                      </li>
                    ))}
                </ul>
              </div>
            )}
          </>
        )}

        {section === 'locations' && (
          <>
            <div className="ref-actions">
              <button
                onClick={() => {
                  const loc: LocationNote = { id: newId(), name: 'New location' }
                  upsertLocation(loc)
                  setSelected(loc.id)
                }}
              >
                Add location
              </button>
            </div>
            <ul className="ref-list">
              {reference.locations
                .filter((l) => keep(l.name))
                .map((l) => (
                  <li
                    key={l.id}
                    className={selected === l.id ? 'on' : ''}
                    onClick={() => setSelected(selected === l.id ? null : l.id)}
                  >
                    <span className="rl-name">{l.name}</span>
                  </li>
                ))}
              {reference.locations.length === 0 && <li className="ref-empty">No locations yet.</li>}
            </ul>
            {selected && reference.locations.some((l) => l.id === selected) && (
              <SimpleForm
                key={selected}
                title={reference.locations.find((l) => l.id === selected)!.name}
                onDelete={() => {
                  removeReferenceItem('locations', selected)
                  setSelected(null)
                }}
              >
                {(() => {
                  const loc = reference.locations.find((l) => l.id === selected)!
                  const set = (patch: Partial<LocationNote>): void =>
                    upsertLocation({ ...loc, ...patch })
                  return (
                    <>
                      <LinkedField
                        label="Name"
                        value={loc.name}
                        linkIndex={linkIndex}
                        onFollow={follow}
                        onChange={(v) => set({ name: v })}
                      />
                      <LinkedField
                        label="Description"
                        value={loc.description ?? ''}
                        long
                        linkIndex={linkIndex}
                        onFollow={follow}
                        onChange={(v) => set({ description: v })}
                      />
                      <LinkedField
                        label="Notes"
                        value={loc.notes ?? ''}
                        long
                        linkIndex={linkIndex}
                        onFollow={follow}
                        onChange={(v) => set({ notes: v })}
                      />
                    </>
                  )
                })()}
              </SimpleForm>
            )}
          </>
        )}

        {section === 'notes' && (
          <>
            <div className="ref-actions">
              <button
                onClick={() => {
                  const note: FreeNote = {
                    id: newId(),
                    title: 'New note',
                    body: '',
                    updatedAt: new Date().toISOString()
                  }
                  upsertNote(note)
                  setSelected(note.id)
                }}
              >
                Add note
              </button>
            </div>
            <ul className="ref-list">
              {reference.notes
                .filter((n) => keep(n.title + ' ' + n.body))
                .map((n) => (
                  <li
                    key={n.id}
                    className={selected === n.id ? 'on' : ''}
                    onClick={() => setSelected(selected === n.id ? null : n.id)}
                  >
                    <span className="rl-name">{n.title}</span>
                  </li>
                ))}
              {reference.notes.length === 0 && <li className="ref-empty">No notes yet.</li>}
            </ul>
            {selected && reference.notes.some((n) => n.id === selected) && (
              <SimpleForm
                key={selected}
                title={reference.notes.find((n) => n.id === selected)!.title}
                onDelete={() => {
                  removeReferenceItem('notes', selected)
                  setSelected(null)
                }}
              >
                {(() => {
                  const note = reference.notes.find((n) => n.id === selected)!
                  const set = (patch: Partial<FreeNote>): void =>
                    upsertNote({ ...note, ...patch, updatedAt: new Date().toISOString() })
                  return (
                    <>
                      <LinkedField
                        label="Title"
                        value={note.title}
                        linkIndex={linkIndex}
                        onFollow={follow}
                        onChange={(v) => set({ title: v })}
                      />
                      <LinkedField
                        label="Body"
                        value={note.body}
                        long
                        linkIndex={linkIndex}
                        onFollow={follow}
                        onChange={(v) => set({ body: v })}
                        hint="Link to anything with [[Name]]."
                      />
                    </>
                  )
                })()}
              </SimpleForm>
            )}
          </>
        )}
      </div>

      {adding && (
        <AddCharacterDialog
          preselect={adding.preselect}
          onClose={() => setAdding(null)}
          onCreate={(note) => {
            upsertCharacterNote(note)
            setCharacterOrder([...profiles.map((p) => p.note.id), note.id])
            setAdding(null)
            openCharacterTab(note.id, note.name)
            onOpenedInEditor?.()
          }}
        />
      )}
    </aside>
  )
}

function SimpleForm({
  title,
  onDelete,
  children
}: {
  title: string
  onDelete: () => void
  children: React.ReactNode
}) {
  return (
    <div className="ref-detail">
      <div className="rd-head">
        <span className="rd-title">{title}</span>
        <button className="ghost rd-delete" title="Delete" onClick={onDelete}>
          Delete
        </button>
      </div>
      {children}
    </div>
  )
}
