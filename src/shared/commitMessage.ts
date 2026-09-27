import type { GitChange } from './api'

/**
 * A commit message worked out from what is being saved.
 *
 * Asking for one was the only thing between a writer and saving, and a box
 * that has to be filled in before a button works reads as a button that does
 * not. So there is always one: scripts first, by the name the episode goes by
 * in the outline, then drafts, the writer's notes, pictures and anything else
 * -- short enough to read as one line in the history, and in words rather
 * than paths.
 *
 *     Chapter 9-2 script changes; Chapter 10 draft changes; outline; .gitignore
 *
 * Scenes are not named. Label names read as code, and a list of them said
 * less about a save than the episode it was in.
 *
 * `nameOf` gives an episode's name from its file name ("episode_1.rpy"); a
 * script the outline does not know is named from the file itself. The writer
 * can still type their own message over all of it.
 */
export function commitMessageFor(
  changes: GitChange[],
  nameOf: (fileName: string) => string | undefined = () => undefined
): string {
  if (changes.length === 0) return ''

  const changed: string[] = []
  const draftsChanged: string[] = []
  const scripts: string[] = []
  const drafts: string[] = []
  const notes: string[] = []
  const other: string[] = []
  let images = 0
  let sounds = 0

  for (const change of changes) {
    const file = change.path.split('/').pop() ?? change.path
    const name = nameOf(file) ?? nameFromFile(file)

    if (/^\.renpywriter\/drafts\/.+\.rpy$/i.test(change.path)) {
      if (change.state === 'modified' || change.state === 'renamed') draftsChanged.push(name)
      else drafts.push(`${verb(change)} ${name} draft`)
    } else if (change.path.startsWith('.renpywriter/')) {
      notes.push(NOTES[file] ?? file.replace(/\.json$/i, ''))
    } else if (/\.rpy$/i.test(file)) {
      if (change.state === 'modified' || change.state === 'renamed') changed.push(name)
      else scripts.push(`${verb(change)} ${withScript(name)}`)
    } else if (change.group === 'image') {
      images++
    } else if (change.group === 'audio') {
      sounds++
    } else {
      other.push(change.state === 'deleted' ? `removed ${file}` : file)
    }
  }

  const phrases = [
    ...(changed.length ? [`${withScript(listed(changed))} changes`] : []),
    ...scripts,
    ...(draftsChanged.length ? [`${listed(draftsChanged)} draft changes`] : []),
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

/** "episode_1.rpy" -> "Episode 1", for a script the outline does not name. */
function nameFromFile(fileName: string): string {
  return fileName
    .replace(/\.rpy$/i, '')
    .split('_')
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ')
}

function verb(change: GitChange): string {
  return change.state === 'deleted' ? 'removed' : 'new'
}

/** "Episode 1 script", but a file called script.rpy is just "Script". */
function withScript(name: string): string {
  return /\bscript$/i.test(name) ? name : `${name} script`
}

/** "A", "A and B", "A, B and C", "A, B, C and 2 more". */
function listed(names: string[]): string {
  if (names.length === 1) return names[0]
  if (names.length <= 3) return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
  return `${names.slice(0, 3).join(', ')} and ${names.length - 3} more`
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
