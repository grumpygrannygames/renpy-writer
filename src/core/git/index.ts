import { spawn } from 'node:child_process'
import { promises as fsp } from 'node:fs'
import * as nodePath from 'node:path'
import { readConflicts, resolvedText, type Decision, type FileConflict } from './conflicts'

/**
 * Talking to git.
 *
 * The system git binary is used rather than a reimplementation: it is already
 * installed on any machine that could clone this project, it already holds the
 * credentials, and it already does the hard parts -- binary transfer,
 * deduplication, conflict detection, history, working offline. None of that is
 * worth rewriting.
 *
 * The rules here are conservative by design, because this code operates on
 * somebody's only copy of their script:
 *
 *   - No command that discards work. No reset, no clean, no checkout --force,
 *     no force push. If a situation needs one of those, it is reported and
 *     left to a person.
 *   - Pulls are fast-forward only. A divergence is a decision, not something
 *     to resolve silently.
 *   - Nothing is committed that the caller did not name.
 *   - No shell. Arguments go across as an array, and the commit message goes
 *     over stdin, so no amount of quoting in a message can become syntax.
 */

export type ChangeState =
  | 'modified'
  | 'added'
  | 'deleted'
  | 'renamed'
  | 'untracked'
  | 'conflicted'

/** Coarse grouping so the UI can say "35 images" instead of listing them. */
export type ChangeGroup = 'script' | 'reference' | 'image' | 'audio' | 'other'

export interface GitChange {
  path: string
  state: ChangeState
  group: ChangeGroup
}

export interface GitIdentity {
  name?: string
  email?: string
}

export interface GitStatus {
  isRepo: boolean
  branch: string | null
  /** e.g. origin/master, or null when the branch tracks nothing. */
  upstream: string | null
  ahead: number
  behind: number
  changes: GitChange[]
  /** Files left conflicted by an earlier merge. Nothing else can run until these are settled. */
  conflicted: string[]
  /** Absent name or email means git will refuse to commit. */
  identity: GitIdentity
  /**
   * A branch on the remote that already holds this work, when it is not the
   * one being tracked -- which is to say, it went up for review.
   *
   * Without this, work waiting on a merge request is indistinguishable from
   * work nobody has seen: both are simply "ahead", and the app would go on
   * offering to send something that has already been sent.
   */
  awaitingReview: string | null
  error?: string
}

/**
 * Somewhere worth going after a push.
 *
 * The URL comes out of what the remote printed, so it is treated as text from
 * a stranger: only http and https are ever offered, and it is shown as a link
 * rather than followed.
 */
export interface GitLink {
  url: string
  label: string
  /** True when the merge request exists. False when this only offers to open one. */
  exists: boolean
}

export interface GitResult {
  ok: boolean
  /** Human-readable outcome, shown as-is. */
  message: string
  detail?: string
  link?: GitLink
  /**
   * Lines two people changed in the same place.
   *
   * Present only when nothing was changed and somebody has to choose. Carried
   * on the result rather than fetched separately so the answer and the reason
   * for it cannot drift apart.
   */
  conflicts?: FileConflict[]
}

interface RunResult {
  code: number
  stdout: string
  stderr: string
  failedToStart?: boolean
}

const GIT_MISSING =
  'git was not found. Install it from git-scm.com and reopen the app, so the project can sync.'

/** Run one git command. Never through a shell, never with a message as an argument. */
function run(cwd: string, args: string[], stdin?: string): Promise<RunResult> {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn('git', args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] })
    } catch {
      resolve({ code: -1, stdout: '', stderr: GIT_MISSING, failedToStart: true })
      return
    }

    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => (stdout += String(d)))
    child.stderr.on('data', (d) => (stderr += String(d)))
    child.on('error', (e: NodeJS.ErrnoException) => {
      resolve({
        code: -1,
        stdout: '',
        stderr: e.code === 'ENOENT' ? GIT_MISSING : e.message,
        failedToStart: true
      })
    })
    child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }))

    if (stdin !== undefined) {
      child.stdin.write(stdin)
      child.stdin.end()
    } else {
      child.stdin.end()
    }
  })
}

function groupOf(filePath: string): ChangeGroup {
  const p = filePath.toLowerCase()
  if (p.startsWith('.renpywriter/')) return 'reference'
  if (p.endsWith('.rpy')) return 'script'
  if (/\.(webp|png|jpg|jpeg|webm|gif|bmp)$/.test(p)) return 'image'
  if (/\.(mp3|ogg|wav|opus|flac)$/.test(p)) return 'audio'
  return 'other'
}

/** Map a porcelain-v2 XY pair to one state, preferring what the worktree says. */
function stateOf(xy: string): ChangeState {
  if (xy.includes('D')) return 'deleted'
  if (xy.includes('R')) return 'renamed'
  if (xy.includes('A')) return 'added'
  return 'modified'
}

/**
 * Read the state of the working copy.
 *
 * `--porcelain=v2 --branch -z` answers everything in one call -- branch,
 * upstream, how far ahead and behind, and every changed path -- and the NUL
 * separation means a file name containing a space or a quote cannot be
 * misparsed.
 */
export async function readStatus(cwd: string): Promise<GitStatus> {
  const empty: GitStatus = {
    isRepo: false,
    branch: null,
    upstream: null,
    ahead: 0,
    behind: 0,
    changes: [],
    conflicted: [],
    identity: {},
    awaitingReview: null
  }

  const inside = await run(cwd, ['rev-parse', '--is-inside-work-tree'])
  if (inside.failedToStart) return { ...empty, error: GIT_MISSING }
  if (inside.code !== 0 || inside.stdout.trim() !== 'true') {
    return { ...empty, error: 'This project folder is not a git repository.' }
  }

  const [name, email, status] = await Promise.all([
    run(cwd, ['config', 'user.name']),
    run(cwd, ['config', 'user.email']),
    run(cwd, ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all'])
  ])

  if (status.code !== 0) {
    return { ...empty, isRepo: true, error: status.stderr.trim() || 'git status failed.' }
  }

  const result: GitStatus = {
    ...empty,
    isRepo: true,
    identity: {
      name: name.code === 0 ? name.stdout.trim() || undefined : undefined,
      email: email.code === 0 ? email.stdout.trim() || undefined : undefined
    }
  }

  const fields = status.stdout.split('\0')
  for (let i = 0; i < fields.length; i++) {
    const line = fields[i]
    if (!line) continue

    if (line.startsWith('# branch.head ')) {
      const head = line.slice('# branch.head '.length)
      result.branch = head === '(detached)' ? null : head
    } else if (line.startsWith('# branch.upstream ')) {
      result.upstream = line.slice('# branch.upstream '.length)
    } else if (line.startsWith('# branch.ab ')) {
      const m = /\+(\d+) -(\d+)/.exec(line)
      if (m) {
        result.ahead = Number(m[1])
        result.behind = Number(m[2])
      }
    } else if (line.startsWith('1 ')) {
      const parts = line.split(' ')
      const path = parts.slice(8).join(' ')
      result.changes.push({ path, state: stateOf(parts[1]), group: groupOf(path) })
    } else if (line.startsWith('2 ')) {
      const parts = line.split(' ')
      const path = parts.slice(9).join(' ')
      result.changes.push({ path, state: 'renamed', group: groupOf(path) })
      // A rename entry is followed by its original path as a separate field.
      i++
    } else if (line.startsWith('u ')) {
      const parts = line.split(' ')
      const path = parts.slice(10).join(' ')
      result.conflicted.push(path)
      result.changes.push({ path, state: 'conflicted', group: groupOf(path) })
    } else if (line.startsWith('? ')) {
      const path = line.slice(2)
      result.changes.push({ path, state: 'untracked', group: groupOf(path) })
    }
  }

  result.changes.sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true }))
  result.awaitingReview = await reviewedAt(cwd, result)
  return result
}

/**
 * Which branch on the remote already holds this work.
 *
 * Costs no network. A push updates this machine's own copy of the remote's
 * refs, so once the commits have gone up as a proposal branch, the answer is
 * sitting on disk -- and it stays right when the app is offline, which is
 * exactly when guessing would be worst.
 *
 * Only asked when there is something ahead, because walking history to answer
 * a question whose answer is "nothing" is a waste of a repository's time.
 */
async function reviewedAt(cwd: string, status: GitStatus): Promise<string | null> {
  if (status.ahead === 0) return null
  const found = await run(cwd, [
    'for-each-ref',
    '--contains',
    'HEAD',
    '--format=%(refname:short)',
    'refs/remotes/'
  ])
  if (found.code !== 0) return null
  const branches = found.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((name) => name && name !== status.upstream && !name.endsWith('/HEAD'))
  return branches[0] ?? null
}

/**
 * Bring in other people's work.
 *
 * Fast-forward only. When the branches have genuinely diverged, merging is a
 * judgement about two sets of changes and the app says so rather than picking
 * one; a writer discovering that their afternoon was silently merged away is
 * a far worse outcome than being asked.
 */
export async function pull(cwd: string): Promise<GitResult> {
  const before = await readStatus(cwd)
  if (!before.isRepo) return { ok: false, message: before.error ?? 'Not a git repository.' }
  if (before.conflicted.length > 0) {
    return {
      ok: false,
      message: 'There are unresolved conflicts. Settle those first.',
      detail: before.conflicted.join('\n')
    }
  }
  if (!before.upstream) {
    return { ok: false, message: 'This branch is not tracking a remote branch yet.' }
  }

  const fetched = await run(cwd, ['fetch', '--quiet'])
  if (fetched.code !== 0) {
    return { ok: false, message: 'Could not reach the remote.', detail: fetched.stderr.trim() }
  }

  const after = await readStatus(cwd)
  if (after.behind === 0) return { ok: true, message: 'Already up to date.' }

  const merged = await run(cwd, ['merge', '--ff-only', '--quiet', '@{u}'])
  if (merged.code !== 0) {

    // Two quite different reasons land here. Saved work of this machine's own
    // is a rebase; unsaved work in the way is a set-aside. Both are things to
    // do, not things to report.
    if (after.ahead > 0) return replayOnto(cwd, after)

    // Unsaved work is in the way. That is not a problem to hand back to
    // somebody: it is one this can do, and doing it is the whole point of a
    // button that says "bring in changes".
    return setAsideAndPull(cwd, after, merged.stderr.trim())
  }

  return {
    ok: true,
    message: `Pulled ${after.behind} change${after.behind === 1 ? '' : 's'}.`
  }
}

/**
 * git's own advice, removed.
 *
 * It is good advice for somebody at a terminal and useless here: "you need to
 * either git merge --no-ff or git rebase" is a instruction nobody using this
 * can follow, sitting under a message saying the app has already handled it.
 * What is left is the part that says what happened.
 */
function withoutAdvice(output: string): string {
  const NEWLINE = String.fromCharCode(10)
  return output
    .split(NEWLINE)
    .filter((line) => !/^\s*hint:/i.test(line))
    .join(NEWLINE)
    .trim()
}

/** How the set-aside shows up in `git stash list`, if anyone ever looks. */
const SET_ASIDE = "Ren'Py Writer: set aside to bring in changes"

/** Files git could not reconcile, named in its own output. */
function conflictedPaths(output: string): string[] {
  const found = new Set<string>()
  for (const line of output.split('\n')) {
    const m = /^CONFLICT \([^)]*\): Merge conflict in (.+)$/.exec(line.trim())
    if (m) found.add(m[1].trim())
  }
  return [...found]
}

/**
 * Bring in changes with unsaved work in the way: set it aside, take the
 * changes, put it back.
 *
 * The rules this follows, in order of how much they matter:
 *
 *   - Work that was set aside is dropped only after it has been put back
 *     cleanly. Every failure between those two points restores it.
 *   - The working copy never ends up holding conflict markers. `<<<<<<<` in a
 *     .rpy file is not a merge in progress, it is a broken game and a parser
 *     that cannot read its own script. When the two sides genuinely disagree
 *     this returns everything to how it was and says so.
 *   - Nothing is discarded that exists nowhere else. The one hard reset here
 *     moves the branch back to a commit recorded seconds earlier, and the
 *     commits it steps back from are still on the remote.
 */
async function setAsideAndPull(
  cwd: string,
  after: GitStatus,
  refusal: string
): Promise<GitResult> {
  const one = after.behind === 1
  const brought = `${after.behind} change${one ? '' : 's'}`

  // Untracked files are a different problem with a different answer: there is
  // nothing to set aside, because git was never keeping them.
  if (/untracked working tree files would be overwritten/i.test(refusal)) {
    return {
      ok: false,
      message:
        `There ${one ? 'is' : 'are'} ${brought} to pull, but ${one ? 'it' : 'they'} would land ` +
        'on top of files here that git does not know about yet. Move those aside first.',
      detail: refusal
    }
  }

  const head = await run(cwd, ['rev-parse', 'HEAD'])
  if (head.code !== 0) {
    return {
      ok: false,
      message: 'Could not read where this branch is, so nothing was changed.',
      detail: head.stderr.trim()
    }
  }
  const startedAt = head.stdout.trim()

  const setAside = await run(cwd, ['stash', 'push', '--message', SET_ASIDE])
  if (setAside.code !== 0) {
    return {
      ok: false,
      message: 'Could not set your unsaved edits aside, so nothing was brought in.',
      detail: setAside.stderr.trim() || refusal
    }
  }

  const merged = await run(cwd, ['merge', '--ff-only', '--quiet', '@{u}'])
  if (merged.code !== 0) {
    await run(cwd, ['stash', 'pop'])
    return {
      ok: false,
      message: 'The changes could not be brought in, so your edits were put straight back.',
      detail: [refusal, merged.stderr.trim()].filter(Boolean).join('\n')
    }
  }

  // apply rather than pop: the set-aside copy stays until it is known to be
  // back safely.
  const restored = await run(cwd, ['stash', 'apply'])
  if (restored.code === 0) {
    await run(cwd, ['stash', 'drop'])
    return {
      ok: true,
      message: `Brought in ${brought}. Your unsaved edits are back where they were.`
    }
  }

  // The same lines were changed on both sides. Put everything back rather than
  // leave a half-merged working copy for somebody to unpick.
  const clash = conflictedPaths(`${restored.stdout}\n${restored.stderr}`)
  const undone = await run(cwd, ['reset', '--hard', startedAt])
  const back = undone.code === 0 ? await run(cwd, ['stash', 'apply']) : undone

  if (back.code !== 0) {
    return {
      ok: false,
      message:
        'The same lines were changed here and elsewhere, and putting this back the way it ' +
        `was did not work. Your edits are safe: git is holding them under "${SET_ASIDE}".`,
      detail: [restored.stderr.trim(), back.stderr.trim()].filter(Boolean).join('\n')
    }
  }
  await run(cwd, ['stash', 'drop'])

  const named = clash.length > 0 ? ` in ${clash.join(', ')}` : ''
  const questions = clash.length > 0 ? await readConflicts(cwd, clash) : []
  const count = questions.reduce((n, f) => n + f.regions.length, 0)

  return {
    ok: false,
    message:
      count > 0
        ? `${count} ${count === 1 ? 'line was' : 'lines were'} changed here and elsewhere at ` +
          `the same time${named}. Nothing has been changed yet: choose which to keep.`
        : `The same lines were changed here and elsewhere${named}, so this is a decision ` +
          'rather than something to do automatically. Nothing was changed: you are exactly ' +
          'where you started, with your edits still here.',
    detail: restored.stdout.trim() || restored.stderr.trim(),
    conflicts: questions.length > 0 ? questions : undefined
  }
}

/** Put unsaved work back, undoing everything if it will not go. */
async function putBack(
  cwd: string,
  startedAt: string,
  didSetAside: boolean
): Promise<{ ok: true } | { clash: string[] } | { stuck: string }> {
  if (!didSetAside) return { ok: true }

  const restored = await run(cwd, ['stash', 'apply'])
  if (restored.code === 0) {
    await run(cwd, ['stash', 'drop'])
    return { ok: true }
  }

  const clash = conflictedPaths(`${restored.stdout}\n${restored.stderr}`)
  const undone = await run(cwd, ['reset', '--hard', startedAt])
  const back = undone.code === 0 ? await run(cwd, ['stash', 'apply']) : undone
  if (back.code !== 0) {
    return { stuck: [restored.stderr.trim(), back.stderr.trim()].filter(Boolean).join('\n') }
  }
  await run(cwd, ['stash', 'drop'])
  return { clash }
}

/**
 * Both sides moved on: replay this machine's work on top of what arrived.
 *
 * A rebase rather than a merge, because the history a writer should be able to
 * read is one thing after another. A merge commit here would record that two
 * people were typing at once, which is true and of no interest to anybody
 * reading the story's history a year later.
 *
 * Every exit restores what was here. A rebase that stops half way is undone
 * with --abort, which is exactly what it is for, and unsaved work goes back
 * from where it was set aside.
 */
async function replayOnto(cwd: string, after: GitStatus): Promise<GitResult> {
  const mine = after.ahead
  const theirs = after.behind
  const ours = `${mine} ${mine === 1 ? 'change' : 'changes'} of your own`

  const head = await run(cwd, ['rev-parse', 'HEAD'])
  if (head.code !== 0) {
    return {
      ok: false,
      message: 'Could not read where this branch is, so nothing was changed.',
      detail: head.stderr.trim()
    }
  }
  const startedAt = head.stdout.trim()

  const needsSetAside = after.changes.some((c) => c.state !== 'untracked')
  const setAside = needsSetAside
    ? await run(cwd, ['stash', 'push', '--message', SET_ASIDE])
    : { code: 0, stdout: '', stderr: '' }
  const didSetAside = needsSetAside && setAside.code === 0

  if (needsSetAside && !didSetAside) {
    return {
      ok: false,
      message: 'Could not set your unsaved edits aside, so nothing was brought in.',
      detail: setAside.stderr.trim()
    }
  }

  const replayed = await run(cwd, ['rebase', '@{u}'])
  if (replayed.code !== 0) {
    // Which files the replay could not settle, before undoing it.
    const during = await readStatus(cwd)
    const stuck = during.conflicted.slice()
    await run(cwd, ['rebase', '--abort'])
    const restored = await putBack(cwd, startedAt, didSetAside)

    if ('stuck' in restored) {
      return {
        ok: false,
        message:
          'Bringing the changes in was undone, but putting your unsaved edits back did not ' +
          `work. They are safe: git is holding them under "${SET_ASIDE}".`,
        detail: restored.stuck
      }
    }

    const files = stuck.length > 0 ? stuck : ('clash' in restored ? restored.clash : [])
    const questions = files.length > 0 ? await readConflicts(cwd, files) : []
    const count = questions.reduce((n, f) => n + f.regions.length, 0)

    return {
      ok: false,
      message:
        count > 0
          ? `${count} ${count === 1 ? 'line was' : 'lines were'} changed here and elsewhere at ` +
            'the same time. Nothing has been changed yet: choose which to keep.'
          : `${theirs} ${theirs === 1 ? 'change' : 'changes'} arrived while you had ${ours} ` +
            'here, and they cannot be put together automatically. Nothing was changed.',
      conflicts: questions.length > 0 ? questions : undefined
    }
  }

  const restored = await putBack(cwd, startedAt, didSetAside)
  if ('stuck' in restored) {
    return {
      ok: false,
      message:
        'The changes came in, but putting your unsaved edits back did not work. They are ' +
        `safe: git is holding them under "${SET_ASIDE}".`,
      detail: restored.stuck
    }
  }
  if ('clash' in restored) {
    const questions = await readConflicts(cwd, restored.clash)
    const count = questions.reduce((n, f) => n + f.regions.length, 0)
    return {
      ok: false,
      message:
        `${count || 'Some'} ${count === 1 ? 'line' : 'lines'} you have not saved were changed ` +
        'elsewhere too. Nothing has been changed yet: choose which to keep.',
      conflicts: questions.length > 0 ? questions : undefined
    }
  }

  return {
    ok: true,
    message:
      `Brought in ${theirs} ${theirs === 1 ? 'change' : 'changes'} and put ${ours} on top. ` +
      `Ready to send.`
  }
}

/**
 * Replay this machine's work on top of what arrived, settling each stop.
 *
 * A rebase stops once per commit it cannot replay cleanly. At each stop the
 * lines somebody chose are written in and the replay carries on, so the
 * answers are given to git rather than git's questions being handed to a
 * person.
 *
 * The loop is bounded. A replay that keeps stopping on a file nobody decided
 * is one this cannot finish, and running forever is a worse way to say so.
 */
async function replayWith(cwd: string, settled: Map<string, string>): Promise<RunResult> {
  let attempt = await run(cwd, ['rebase', '@{u}'])

  for (let step = 0; attempt.code !== 0 && step < 50; step++) {
    const during = await readStatus(cwd)
    if (during.conflicted.length === 0) break

    let wroteEvery = true
    for (const file of during.conflicted) {
      const text = settled.get(file)
      if (text === undefined) {
        wroteEvery = false
        break
      }
      await fsp.writeFile(nodePath.join(cwd, file), text, 'utf8')
      await run(cwd, ['add', '--', file])
    }
    if (!wroteEvery) break

    // core.editor=true accepts the message git already has. Without it the
    // replay waits for an editor that will never open.
    attempt = await run(cwd, ['-c', 'core.editor=true', 'rebase', '--continue'])
  }

  return attempt
}

/**
 * Bring in changes once somebody has said which lines to keep.
 *
 * The order is the same as an ordinary bring-in -- set aside, fast-forward,
 * put back -- with one difference: instead of asking git to reapply the work
 * and hoping, the files this knows about are written from the answers given.
 * Nothing is left to a second merge that might reach a different conclusion
 * than the one somebody was shown.
 */
export async function resolvePull(cwd: string, decisions: Decision[]): Promise<GitResult> {
  const status = await readStatus(cwd)
  if (!status.isRepo) return { ok: false, message: status.error ?? 'Not a git repository.' }
  if (!status.upstream) {
    return { ok: false, message: 'This branch is not tracking a remote branch yet.' }
  }
  if (status.behind === 0) {
    return { ok: false, message: 'There is nothing to bring in any more. Try again.' }
  }

  const files = [...new Set(decisions.map((d) => d.file))]
  if (files.length === 0) return { ok: false, message: 'Nothing was decided.' }

  // Work out the answers before touching anything, so a half-decided set stops
  // here rather than after the branch has already moved.
  const settled = new Map<string, string>()
  for (const file of files) {
    const result = await resolvedText(cwd, file, decisions)
    if ('missing' in result) {
      return {
        ok: false,
        message:
          result.missing.length > 0
            ? `${result.missing.length} line${result.missing.length === 1 ? '' : 's'} in ` +
              `${file} still need${result.missing.length === 1 ? 's' : ''} choosing.`
            : `Could not work out what ${file} should say. Nothing was changed.`
      }
    }
    settled.set(file, result.text)
  }

  // Everything else that was unsaved, kept exactly as it is on disk now.
  const carried = new Map<string, string>()
  for (const change of status.changes) {
    if (change.state === 'untracked' || settled.has(change.path)) continue
    try {
      carried.set(change.path, await fsp.readFile(nodePath.join(cwd, change.path), 'utf8'))
    } catch {
      // A file that cannot be read here is one the merge will not disturb.
    }
  }

  const setAside = await run(cwd, ['stash', 'push', '--message', SET_ASIDE])
  const didSetAside = setAside.code === 0 && !/no local changes/i.test(setAside.stdout)

  // How the answers get applied depends on why they were needed. Nothing to
  // send means a fast-forward; work of this machine's own means replaying it
  // on top, settling each stop with the lines that were chosen.
  //
  // Getting this wrong is what sent somebody round in a circle: a
  // fast-forward cannot happen when this branch is ahead, so answering the
  // questions failed and asked them again.
  const joined =
    status.ahead === 0
      ? await run(cwd, ['merge', '--ff-only', '--quiet', '@{u}'])
      : await replayWith(cwd, settled)

  if (joined.code !== 0) {
    if (status.ahead > 0) await run(cwd, ['rebase', '--abort'])
    if (didSetAside) await run(cwd, ['stash', 'pop'])
    return {
      ok: false,
      message: 'The changes could not be brought in, so your edits were put straight back.',
      detail: withoutAdvice(joined.stderr)
    }
  }

  try {
    for (const [file, text] of [...settled, ...carried]) {
      await fsp.writeFile(nodePath.join(cwd, file), text, 'utf8')
    }
  } catch (e) {
    return {
      ok: false,
      message:
        'The changes came in, but writing your edits back on top of them failed. Your work is ' +
        `safe: git is holding it under "${SET_ASIDE}".`,
      detail: e instanceof Error ? e.message : String(e)
    }
  }

  if (didSetAside) await run(cwd, ['stash', 'drop'])

  const kept = decisions.filter((d) => d.take === 'mine').length
  const took = decisions.filter((d) => d.take === 'theirs').length
  const wrote = decisions.filter((d) => d.take === 'custom').length
  const parts = [
    kept > 0 ? `kept ${kept}` : null,
    took > 0 ? `took ${took}` : null,
    wrote > 0 ? `rewrote ${wrote}` : null
  ].filter(Boolean)

  return {
    ok: true,
    message: `Brought the changes in, and ${parts.join(', ')} of the lines you chose.`
  }
}

/**
 * Ask the remote what it has, then report where this branch stands.
 *
 * `readStatus` alone answers from what is already on this machine, so "1 to
 * bring in" can be an hour old and "in step" can be wrong. That is fine for
 * the numbers shown after an action -- pulling and sending both talk to the
 * remote themselves -- and not fine for the numbers somebody sees on opening
 * the panel to decide whether to do anything.
 *
 * A failed fetch is not an error here. Being offline is a reason to show what
 * is known rather than to show nothing.
 */
export async function fetchStatus(cwd: string): Promise<GitStatus> {
  const before = await readStatus(cwd)
  if (!before.isRepo || !before.upstream) return before
  await run(cwd, ['fetch', '--quiet'])
  return readStatus(cwd)
}

export interface CommitRequest {
  message: string
  /** Repository-relative paths to include. Nothing else is committed. */
  paths: string[]
  /** Push afterwards when the branch has somewhere to push to. */
  push?: boolean
  /**
   * Who made this change.
   *
   * Given per commit rather than taken from the repository's own config,
   * because one checkout can be shared: a server commits on behalf of whoever
   * is signed in, and history saying "the server did it" is history that
   * cannot answer who wrote a line.
   */
  author?: { name: string; email: string }
}

/** Commit the named paths, and optionally send them on. */
export async function commit(cwd: string, request: CommitRequest): Promise<GitResult> {
  const status = await readStatus(cwd)
  if (!status.isRepo) return { ok: false, message: status.error ?? 'Not a git repository.' }
  if (status.conflicted.length > 0) {
    return { ok: false, message: 'There are unresolved conflicts. Settle those first.' }
  }
  // An author supplied by the caller stands in for the repository's own.
  if (!request.author && (!status.identity.name || !status.identity.email)) {
    return {
      ok: false,
      message:
        'git does not know who you are yet, so it will not record a commit. Set a name and ' +
        'email with: git config --global user.name "Your Name" and git config --global ' +
        'user.email "you@example.com".'
    }
  }
  if (request.paths.length === 0) return { ok: false, message: 'Nothing selected to save.' }
  if (!request.message.trim()) return { ok: false, message: 'A commit needs a message.' }

  // `--` keeps a path that begins with a dash from being read as an option.
  const staged = await run(cwd, ['add', '--', ...request.paths])
  if (staged.code !== 0) {
    return { ok: false, message: 'Could not stage those files.', detail: staged.stderr.trim() }
  }

  // The message goes over stdin, so quotes and newlines in it are just text.
  const identity = request.author
    ? ['-c', `user.name=${request.author.name}`, '-c', `user.email=${request.author.email}`]
    : []
  const made = await run(cwd, [...identity, 'commit', '--file', '-'], request.message)
  if (made.code !== 0) {
    const detail = made.stderr.trim() || made.stdout.trim()
    if (/nothing to commit|no changes added/i.test(detail)) {
      return { ok: false, message: 'Those files were already saved.' }
    }
    return { ok: false, message: 'Could not record the commit.', detail }
  }

  const count = request.paths.length
  const saved = `Saved ${count} file${count === 1 ? '' : 's'}.`
  if (!request.push) return { ok: true, message: saved }

  if (!status.upstream) {
    return {
      ok: true,
      message: `${saved} It was not sent anywhere: this branch tracks no remote branch.`
    }
  }

  // Read the state again: the commit just made moved this branch on, and how
  // far ahead it is now is what gets reported.
  const sent = await send(cwd, await readStatus(cwd), request.author)
  return { ...sent, message: `${saved} ${sent.message}` }
}

/**
 * Branch names allow far more than this; keeping to the boring part of what
 * they allow means a person's name never has to be thought about again.
 */
function slug(text: string, max = 24): string {
  const cleaned = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return cleaned.slice(0, max).replace(/-+$/, '') || 'writer'
}

/**
 * Where one person's changes for one branch go.
 *
 * Deliberately the same name every time: a second round of edits joins the
 * branch already under review instead of opening a second merge request about
 * the same work. Two people proposing changes to the same branch still get one
 * each.
 */
function proposalBranch(base: string, who: string): string {
  return `proposal/${slug(who)}-to-${slug(base)}`
}

/** The remote has commits this branch does not; the answer is to pull. */
function behindRemote(output: string): boolean {
  return /\((?:fetch first|non-fast-forward|stale info)\)/i.test(output)
}

/**
 * Did the far end refuse this, or did git decline before anything left?
 *
 * The distinction decides what happens next. A refusal is the remote saying
 * "not straight onto this branch", which is exactly what a proposal branch is
 * for. Being behind is not that -- it means pull -- and turning it into a
 * merge request would propose work that is simply out of date.
 *
 * Matched on git's own wording rather than any one host's, so a self-hosted
 * GitLab, GitHub and a bare repository with a hook all land in the same place.
 */
function refusedByRemote(output: string): boolean {
  if (behindRemote(output)) return false
  return /\[remote rejected\]|hook declined|protected branch|not allowed to push|permission denied to/i.test(
    output
  )
}

/**
 * What this host calls a request to merge one branch into another.
 *
 * Not cosmetic. Somebody told to look for a merge request on a site whose
 * every button says "pull request" is being sent to find something that, by
 * that name, is not there. The link the remote printed already says which
 * kind it is, so the word can come from the same place as the URL.
 */
function requestWord(url: string | null): string {
  if (url && /\/(?:pull|pull-requests)\//i.test(url)) return 'pull request'
  if (url && /merge_requests/i.test(url)) return 'merge request'
  return 'merge request'
}

const LINK_EXISTS = /https?:\/\/[^\s]*?\/(?:merge_requests|pull|pull-requests)\/\d+/i
const LINK_CREATE =
  /https?:\/\/[^\s]*(?:merge_requests\/new|pull\/new|pull-requests\/new|\/compare\/)[^\s]*/i

/**
 * Find the merge request in what the remote printed.
 *
 * Hosts print two quite different links and they must not be confused: one to
 * a merge request that exists, one to a page that would create one. Claiming
 * the second is the first would tell somebody their work is waiting for review
 * when nobody has been asked to look at it.
 */
function findLink(output: string): GitLink | null {
  const tidy = (url: string): string => url.replace(/[).,;:]+$/, '')
  const existing = LINK_EXISTS.exec(output)
  if (existing) {
    const url = tidy(existing[0])
    return { url, label: `View the ${requestWord(url)}`, exists: true }
  }
  const create = LINK_CREATE.exec(output)
  if (create) {
    const url = tidy(create[0])
    return { url, label: `Open a ${requestWord(url)}`, exists: false }
  }
  return null
}

/**
 * How many commits here have not reached the remote.
 *
 * Usually the count git already worked out, but not always: on the very first
 * push the upstream branch does not exist yet, so git reports nothing ahead
 * of it while every commit in the checkout is in fact unsent. Reporting "sent
 * 0 commits" after sending several is the kind of small lie that makes a
 * person stop believing the rest of the sentence.
 */
async function unsent(cwd: string, status: GitStatus): Promise<number> {
  if (status.ahead > 0) return status.ahead
  const counted = await run(cwd, ['rev-list', '--count', 'HEAD', '--not', '--remotes'])
  const n = Number(counted.stdout.trim())
  return counted.code === 0 && Number.isFinite(n) ? n : 0
}

/** "3 commits", or nothing at all when the count is not to be trusted. */
function countPhrase(n: number): string {
  return n > 0 ? `${n} commit${n === 1 ? '' : 's'}` : 'the changes'
}

/**
 * Get recorded commits to the remote, one way or another.
 *
 * A direct push is always tried first, every single time. Whether somebody may
 * write to a branch is the remote's business and it can change between one
 * afternoon and the next -- a token regranted, a branch newly protected -- so
 * nothing about the last answer is remembered. The cost of asking is one round
 * trip; the cost of remembering wrongly is either a refusal presented as a
 * bug, or a merge request opened for somebody who could simply have pushed.
 */
async function send(
  cwd: string,
  status: GitStatus,
  author?: { name: string; email: string }
): Promise<GitResult> {
  const remote = (status.upstream ?? 'origin/').split('/')[0] || 'origin'
  const n = await unsent(cwd, status)
  const commits = countPhrase(n)

  const direct = await run(cwd, ['push'])
  if (direct.code === 0) return { ok: true, message: `Sent ${commits} to ${remote}.` }

  const refusal = `${direct.stdout}\n${direct.stderr}`.trim()

  if (behindRemote(refusal)) {
    return {
      ok: false,
      message:
        `${remote} has changes this branch does not, so it would not take ${commits}. ` +
        'Bring in changes first, then send again.',
      detail: refusal
    }
  }
  if (!refusedByRemote(refusal)) {
    return {
      ok: false,
      message: 'Could not send. The commits are safe here and can be sent again later.',
      detail: refusal
    }
  }
  return propose(cwd, status, remote, n, refusal, author)
}

/**
 * Offer refused work as a branch, and ask for it to be reviewed.
 *
 * Nothing here says a merge request exists until the remote has printed a link
 * to one. A branch sitting on a server that nobody has been asked to look at
 * is not a submission, and reporting it as one would leave somebody waiting on
 * a review that was never requested.
 */
async function propose(
  cwd: string,
  status: GitStatus,
  remote: string,
  n: number,
  refusal: string,
  author?: { name: string; email: string }
): Promise<GitResult> {
  const base = status.branch
  const commits = countPhrase(n)
  const are = n === 1 ? 'is' : 'are'
  const them = n === 1 ? 'it' : 'them'
  if (!base) {
    return {
      ok: false,
      message:
        `${remote} refused this push, and there is no branch here to offer instead: ` +
        'this checkout is not on one.',
      detail: refusal
    }
  }

  const who = author?.name || status.identity.name || 'writer'
  const branch = proposalBranch(base, who)

  // Whether the branch is already up there decides whether to ask for a merge
  // request. Asking again for one that exists is how a review ends up split
  // across two.
  const known = await run(cwd, ['ls-remote', '--heads', remote, `refs/heads/${branch}`])
  const isNew = known.code === 0 && known.stdout.trim() === ''

  const subject = await run(cwd, ['log', '-1', '--format=%s'])
  const title =
    n === 1 && subject.code === 0 && subject.stdout.trim()
      ? subject.stdout.trim()
      : `${who}: ${commits} for ${base}`

  const options = [
    '-o',
    'merge_request.create',
    '-o',
    `merge_request.target=${base}`,
    '-o',
    `merge_request.title=${title}`
  ]
  const target = [remote, `HEAD:refs/heads/${branch}`]

  let sent = await run(cwd, ['push', ...(isNew ? options : []), ...target])
  let output = `${sent.stdout}\n${sent.stderr}`.trim()

  // Push options are not universal. A remote that has never heard of them
  // refuses the whole push and takes nothing, and the branch still deserves to
  // go up -- without a merge request, which is then said plainly.
  if (sent.code !== 0 && isNew && /does not support push options/i.test(output)) {
    sent = await run(cwd, ['push', ...target])
    output = `${sent.stdout}\n${sent.stderr}`.trim()
  }

  if (sent.code !== 0) {
    const clash = behindRemote(output)
      ? ` The branch at ${remote} already holds work that is not in this checkout.`
      : ''
    return {
      ok: false,
      message:
        `${remote} would not take ${commits} onto ${base}, and offering ${them} as ` +
        `“${branch}” did not work either, so nothing was sent.${clash}`,
      detail: [refusal, output].filter(Boolean).join('\n\n')
    }
  }

  const link = findLink(output)

  // Sending the same commits again: the branch has them already. Say that, and
  // say nothing about a merge request this push knows nothing about.
  if (/everything up-to-date/i.test(output)) {
    return {
      ok: true,
      message:
        `${remote} does not take changes onto ${base} directly, and ${commits} ${are} ` +
        `already waiting on “${branch}”.`,
      link: link ?? undefined
    }
  }

  if (link?.exists) {
    // A second round of edits belongs to the review that is already open, and
    // reads as such: nothing new was opened, the same one grew.
    return {
      ok: true,
      message: isNew
        ? `${remote} does not take changes onto ${base} directly, so ${commits} went up ` +
          `as “${branch}” for review.`
        : `Added ${commits} to “${branch}”, which is already up for review.`,
      link
    }
  }

  return {
    ok: false,
    message:
      `${commits[0].toUpperCase()}${commits.slice(1)} ${are} up at ${remote} on ` +
      `“${branch}”, but no ${requestWord(link?.url ?? null)} was created, so nobody has ` +
      `been asked to look at ${them}.` +
      (link ? ' Use the link below to open one.' : ''),
    detail: [refusal, output].filter(Boolean).join('\n\n'),
    link: link ?? undefined
  }
}

/**
 * Send commits that are already recorded.
 *
 * Separate from commit because the two fail independently: a push can fail on
 * a train with no signal, leaving perfectly good commits stranded. Without a
 * way to retry sending on its own, the only route out would be making another
 * commit, which is a silly thing to have to do.
 */
export async function push(
  cwd: string,
  author?: { name: string; email: string }
): Promise<GitResult> {
  const status = await readStatus(cwd)
  if (!status.isRepo) return { ok: false, message: status.error ?? 'Not a git repository.' }
  if (!status.upstream) {
    return { ok: false, message: 'This branch is not tracking a remote branch yet.' }
  }
  // Nothing ahead is usually nothing to do -- unless the branch has never
  // been pushed, when there is no upstream to be ahead of.
  if (status.ahead === 0 && (await unsent(cwd, status)) === 0) {
    return { ok: true, message: 'Nothing to send.' }
  }
  return send(cwd, status, author)
}
