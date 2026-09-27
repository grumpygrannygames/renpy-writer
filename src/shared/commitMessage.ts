import type { GitChange } from './api'

/**
 * A commit message worked out from what is being saved.
 *
 * Asking for one was the only thing between a writer and saving, and a box
 * that has to be filled in before a button works reads as a button that does
 * not. So there is always one: scripts first, by the scenes that changed in
 * them, then drafts, the writer's notes, pictures and anything else -- short
 * enough to read as one line in the history, and in words rather than paths.
 *
 *     chapter_9_2: D17_SECRET_RANDEZVOUS; chapter_10 draft; outline; .gitignore
 *
 * The writer can still type their own over it.
 */
export function commitMessageFor(changes: GitChange[]): string {
  if (changes.length === 0) return ''

  const scripts: string[] = []
  const drafts: string[] = []
  const notes: string[] = []
  const other: string[] = []
  let images = 0
  let sounds = 0

  for (const change of changes) {
    const file = change.path.split('/').pop() ?? change.path
    const stem = file.replace(/\.rpy$/i, '')

    if (/^\.renpywriter\/drafts\/.+\.rpy$/i.test(change.path)) {
      drafts.push(scriptPhrase(`${stem} draft`, change))
    } else if (change.path.startsWith('.renpywriter/')) {
      notes.push(NOTES[file] ?? stem)
    } else if (/\.rpy$/i.test(file)) {
      scripts.push(scriptPhrase(stem, change))
    } else if (change.group === 'image') {
      images++
    } else if (change.group === 'audio') {
      sounds++
    } else {
      other.push(change.state === 'deleted' ? `removed ${file}` : file)
    }
  }

  const phrases = [
    ...scripts,
    ...drafts,
    ...unique(notes),
    ...(images ? [`${images} ${images === 1 ? 'picture' : 'pictures'}`] : []),
    ...(sounds ? [`${sounds} ${sounds === 1 ? 'sound' : 'sounds'}`] : []),
    ...other
  ]
  return fit(phrases, LIMIT)
}

/** What each notes file is, to somebody who never opens it. */
const NOTES: Record<string, string> = {
  'characters.json': 'character profiles',
  'locations.json': 'locations',
  'notes.json': 'notes',
  'outline.json': 'outline',
  'project.json': 'project settings'
}

/**
 * About as much as a history list shows of a message before it cuts it off.
 * Past that, what is left is counted rather than listed.
 */
const LIMIT = 100

/** One script: new, gone, or which of its scenes changed. */
function scriptPhrase(name: string, change: GitChange): string {
  if (change.state === 'untracked' || change.state === 'added') return `new ${name}`
  if (change.state === 'deleted') return `removed ${name}`
  const scenes = change.scenes ?? []
  if (scenes.length === 0) return name
  const shown = scenes.slice(0, 3).join(', ')
  const more = scenes.length - 3
  return more > 0 ? `${name}: ${shown} and ${more} more` : `${name}: ${shown}`
}

function unique(items: string[]): string[] {
  return [...new Set(items)]
}

/** As many phrases as fit, and a count of the rest. */
function fit(phrases: string[], limit: number): string {
  const all = phrases.join('; ')
  if (all.length <= limit) return all
  const kept: string[] = []
  for (const phrase of phrases) {
    const rest = phrases.length - kept.length - 1
    const tail = rest > 0 ? `; and ${rest} more` : ''
    if ([...kept, phrase].join('; ').length + tail.length > limit && kept.length > 0) break
    kept.push(phrase)
  }
  const left = phrases.length - kept.length
  return left > 0 ? `${kept.join('; ')}; and ${left} more` : kept.join('; ')
}
