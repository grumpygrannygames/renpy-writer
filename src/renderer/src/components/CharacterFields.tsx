import { useLayoutEffect, useRef, useState, type RefObject } from 'react'
import type { CharacterNote } from '@shared/types'
import { parseLinks, type RefTarget } from '../wikiLink'

/**
 * Order matters: this is the sequence a character is thought about in, not
 * alphabetical. Accent sits with the factual fields because it drives
 * translation; the long-form fields follow.
 */
type FieldKey =
  | 'fullName'
  | 'birthday'
  | 'age'
  | 'accent'
  | 'bio'
  | 'trivia'
  | 'relations'
  | 'storyHooks'

interface FieldSpec {
  key: FieldKey
  label: string
  long?: boolean
  placeholder?: string
  hint?: string
}

export const CHARACTER_FIELDS: FieldSpec[] = [
  { key: 'fullName', label: 'Full name', placeholder: 'e.g. James Cook' },
  { key: 'birthday', label: 'Birthday', placeholder: 'e.g. December 6' },
  { key: 'age', label: 'Age' },
  {
    key: 'accent',
    label: 'Accent, slang or dialect',
    placeholder: 'e.g. Southerner, Ghetto',
    hint: 'Read by the translation pass to flavour this character’s voice.'
  },
  { key: 'bio', label: 'Bio', long: true },
  { key: 'trivia', label: 'Trivia', long: true },
  { key: 'relations', label: 'Relations', long: true },
  { key: 'storyHooks', label: 'Story hooks', long: true }
]

interface Props {
  note: CharacterNote
  linkIndex: Map<string, RefTarget>
  onFollow: (t: RefTarget) => void
  onChange: (n: CharacterNote) => void
  /** 'full' gives the long fields room for pages of text. */
  layout: 'panel' | 'full'
}

export default function CharacterFields({ note, linkIndex, onFollow, onChange, layout }: Props) {
  const set = (patch: Partial<CharacterNote>): void => onChange({ ...note, ...patch })

  return (
    <div className={'charfields ' + layout}>
      <LinkedField
        label="Name"
        value={note.name}
        linkIndex={linkIndex}
        onFollow={onFollow}
        onChange={(v) => set({ name: v.trim() || note.name })}
        hint="The name used in your notes. Script display names are set at the bottom of the page."
      />

      {CHARACTER_FIELDS.map((f) => (
        <LinkedField
          key={f.key}
          label={f.label}
          value={note[f.key] ?? ''}
          placeholder={f.placeholder}
          hint={f.hint}
          long={f.long}
          layout={layout}
          linkIndex={linkIndex}
          onFollow={onFollow}
          onChange={(v) => set({ [f.key]: v } as Partial<CharacterNote>)}
        />
      ))}
    </div>
  )
}

// -------------------------------------------------------------- linked field

interface FieldProps {
  label: string
  value: string
  placeholder?: string
  hint?: string
  long?: boolean
  layout?: 'panel' | 'full'
  linkIndex: Map<string, RefTarget>
  onFollow: (t: RefTarget) => void
  onChange: (value: string) => void
}

/**
 * Reads as linked prose until clicked, then becomes an input. Editing shows
 * the raw [[Name]] syntax; the read view resolves it.
 */
export function LinkedField({
  label,
  value,
  placeholder,
  hint,
  long,
  layout = 'panel',
  linkIndex,
  onFollow,
  onChange
}: FieldProps) {
  const [editing, setEditing] = useState(false)
  const ref = useRef<HTMLTextAreaElement | HTMLInputElement>(null)

  // Layout effect, not effect: this has to claim focus inside the same task as
  // the mousedown that opened the field, before anything else can take it.
  useLayoutEffect(() => {
    if (!editing) return
    const el = ref.current
    if (!el) return
    el.focus()
    el.setSelectionRange(el.value.length, el.value.length)
  }, [editing])

  const longClass = long ? ' long' : ''
  const rows = long ? (layout === 'full' ? 24 : 10) : 4

  // Deliberately a div, not a label: a <label> with no `for` activates its
  // first labelable descendant, which in read mode is the first [[wiki link]]
  // button. Clicking the text to edit it would silently follow that link.
  return (
    <div className={'ref-field' + longClass}>
      <span className="rf-label">{label}</span>
      {editing ? (
        long ? (
          <textarea
            ref={ref as RefObject<HTMLTextAreaElement>}
            className="rf-long"
            defaultValue={value}
            placeholder={placeholder}
            rows={rows}
            onBlur={(e) => {
              onChange(e.target.value)
              setEditing(false)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Escape') e.currentTarget.blur()
            }}
          />
        ) : (
          <input
            ref={ref as RefObject<HTMLInputElement>}
            defaultValue={value}
            placeholder={placeholder}
            onBlur={(e) => {
              onChange(e.target.value)
              setEditing(false)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === 'Escape') e.currentTarget.blur()
            }}
          />
        )
      ) : (
        <div
          className={'rf-view' + longClass + (value ? '' : ' empty')}
          // mousedown, not click: clicking away from another open field blurs
          // it first, which re-renders and moves the element out from under the
          // pointer, so the click never lands and a second click is needed.
          //
          // preventDefault is what makes it stick. A press normally ends by
          // moving focus to whatever sits under the pointer; by then this view
          // has been replaced by the input, so the browser would focus nothing,
          // blur the fresh input and close the field again — the press would
          // look completely ignored. Suppressing the default leaves focus to
          // the layout effect above.
          onMouseDown={(e) => {
            e.preventDefault()
            setEditing(true)
          }}
          title="Click to edit"
        >
          {value ? (
            parseLinks(value, linkIndex).map((seg, i) =>
              seg.kind === 'text' ? (
                <span key={i}>{seg.text}</span>
              ) : (
                <button
                  key={i}
                  type="button"
                  className={'wikilink' + (seg.target ? '' : ' unresolved')}
                  title={seg.target ? `Go to ${seg.target.name}` : 'Nothing named this yet'}
                  onMouseDown={(e) => {
                    // Beat the field's own mousedown so following a link does
                    // not also drop the field into edit mode.
                    e.stopPropagation()
                    e.preventDefault()
                    if (seg.target) onFollow(seg.target)
                  }}
                >
                  {seg.text}
                </button>
              )
            )
          ) : (
            <span>{placeholder ?? 'Empty'}</span>
          )}
        </div>
      )}
      {hint && <span className="rf-hint">{hint}</span>}
    </div>
  )
}
