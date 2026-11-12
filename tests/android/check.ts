/**
 * The Android app's backend, run on a computer.
 *
 * Everything above the Java plugin is the real phone code: the shims standing
 * in for Node's modules, the local transport, the shared handlers and the
 * text-only clone. Only the plugin is played by tests/android/fakeHost.ts.
 *
 *     npm run test:android
 */
import { forGit, where } from './fakeHost'
import { createLocalApi } from '../../src/android/localApi'
import { cloneTextOnly, withToken, withoutCredentials } from '@core/git'

const fs = process.getBuiltinModule('fs') as typeof import('node:fs')
const os = process.getBuiltinModule('os') as typeof import('node:os')
const nodePath = process.getBuiltinModule('path') as typeof import('node:path')
const cp = process.getBuiltinModule('child_process') as typeof import('node:child_process')

let pass = 0
let fail = 0
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) pass++
  else fail++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${ok || !detail ? '' : ` -- ${detail}`}`)
}

function git(cwd: string, ...args: string[]): string {
  const r = cp.spawnSync('git', args.map(forGit), { cwd, encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`)
  return r.stdout
}

async function main(): Promise<void> {
  // Phone-shaped paths: starting at /, with forward slashes. Windows reads
  // /Users/... as a path on the current drive, so the same string works for
  // this computer's files and for the phone's path handling.
  const base = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'rpw-android-'))
    .replace(/^[A-Za-z]:/, '').split(nodePath.sep).join('/')
  where.files = nodePath.posix.join(base, 'phone')
  where.cache = nodePath.posix.join(base, 'phone-cache')
  fs.mkdirSync(where.files)
  fs.mkdirSync(where.cache)
  const api = createLocalApi()

  console.log('\n[a game, as it is on the desktop]')
  const desk = nodePath.posix.join(base, 'desk')
  fs.mkdirSync(nodePath.posix.join(desk, 'game', 'scripts'), { recursive: true })
  fs.mkdirSync(nodePath.posix.join(desk, 'game', 'images'), { recursive: true })
  fs.writeFileSync(
    nodePath.posix.join(desk, 'game', 'scripts', 'chapter_1.rpy'),
    'label start:\n    "It begins."\n    jump second\n\nlabel second:\n    "And goes on."\n'
  )
  // Artwork: what a phone copy must leave behind.
  fs.writeFileSync(nodePath.posix.join(desk, 'game', 'images', 'bg_room.png'), Buffer.alloc(200_000, 7))
  git(desk, 'init', '--quiet', '--initial-branch=main')
  git(desk, 'config', 'user.name', 'Desk')
  git(desk, 'config', 'user.email', 'desk@example.com')

  // Made the way a phone makes anything: through the shims.
  const created = await api.createProject({
    name: 'Phone Test',
    renpyRoot: desk,
    settings: (await import('@shared/types')).DEFAULT_SETTINGS
  })
  check('a project can be created through the phone backend', created.project.name === 'Phone Test')
  check('and its notes are on disk', fs.existsSync(nodePath.posix.join(desk, '.renpywriter', 'project.json')))
  git(desk, 'add', '-A')
  git(desk, 'commit', '--quiet', '-m', 'start')
  const remote = nodePath.posix.join(base, 'remote.git')
  git(base, 'clone', '--quiet', '--bare', desk, remote)
  git(remote, 'config', 'uploadpack.allowFilter', 'true')
  git(remote, 'config', 'uploadpack.allowAnySHA1InWant', 'true')
  git(desk, 'remote', 'add', 'origin', remote)
  git(desk, 'fetch', '--quiet', 'origin')
  git(desk, 'branch', '--quiet', '--set-upstream-to=origin/main')

  console.log('\n[copied to the phone without its artwork]')
  const phone = nodePath.posix.join(where.files, 'projects', 'phone-test')
  const cloned = await cloneTextOnly('file://' + remote, phone, {
    name: 'Phone',
    email: 'phone@example.com'
  })
  check('the copy succeeds', cloned.ok, JSON.stringify(cloned))
  check('the scripts are there', fs.existsSync(nodePath.posix.join(phone, 'game', 'scripts', 'chapter_1.rpy')))
  check('and the notes', fs.existsSync(nodePath.posix.join(phone, '.renpywriter', 'project.json')))
  check('but not the artwork', !fs.existsSync(nodePath.posix.join(phone, 'game', 'images', 'bg_room.png')))
  check('commits made here are signed as the phone',
    git(phone, 'config', 'user.name').trim() === 'Phone')

  const opened = await api.openProject(phone)
  check('the copy opens', opened.project.name === 'Phone Test', opened.project.name)
  // Not an episode yet -- a new project adopts nothing on its own -- but found.
  check('with its script found', opened.unregisteredFiles.includes('chapter_1.rpy'),
    JSON.stringify(opened.unregisteredFiles))
  const listed = await api.listProjects()
  check('and is on the phone’s list of projects', listed.projects.some((p) => p.renpyRoot === phone))

  const status = await api.gitStatus(phone)
  check('a fresh copy has nothing to send', status.changes.length === 0,
    JSON.stringify(status.changes.map((c) => c.path)))

  console.log('\n[written on the phone, sent]')
  const before = await api.readEpisode(phone, 'chapter_1.rpy')
  await api.writeEpisode(phone, 'chapter_1.rpy', before.replace('"And goes on."', '"And goes on, on a train."'))
  const edited = await api.gitStatus(phone)
  check('the edit shows as a change', edited.changes.some((c) => c.path === 'game/scripts/chapter_1.rpy'),
    JSON.stringify(edited.changes.map((c) => c.path)))
  check('and nothing about the missing artwork does',
    !edited.changes.some((c) => c.path.includes('images')), JSON.stringify(edited.changes))

  const sent = await api.gitCommit(phone, {
    message: 'Chapter 1 script changes',
    paths: edited.changes.map((c) => c.path),
    push: true
  })
  check('Save and send works', sent.ok, JSON.stringify(sent))
  const tree = git(remote, 'ls-tree', '-r', '--name-only', 'main')
  check('the remote has the edit', git(remote, 'show', 'main:game/scripts/chapter_1.rpy').includes('on a train'))
  check('and still has the artwork the phone never had', tree.includes('game/images/bg_room.png'), tree)

  console.log('\n[written on the desktop, brought in]')
  git(desk, 'pull', '--quiet')
  fs.appendFileSync(nodePath.posix.join(desk, 'game', 'scripts', 'chapter_1.rpy'), '    "Written at the desk."\n')
  git(desk, 'commit', '--quiet', '-am', 'desk')
  git(desk, 'push', '--quiet')
  const behind = await api.gitFetchStatus(phone)
  check('the phone sees there is something to bring in', behind.behind === 1, JSON.stringify(behind))
  const pulled = await api.gitPull(phone)
  check('bringing it in works', pulled.ok, JSON.stringify(pulled))
  check('and the desk’s line is on the phone',
    (await api.readEpisode(phone, 'chapter_1.rpy')).includes('Written at the desk.'))

  console.log('\n[adding a project, refused plainly]')
  const refused = async (input: Partial<Parameters<typeof api.cloneProject>[0]>): Promise<string> => {
    try {
      await api.cloneProject({ url: '', token: '', authorName: 'A', authorEmail: 'a@b.c', ...input })
      return 'accepted'
    } catch (e) {
      return e instanceof Error ? e.message : String(e)
    }
  }
  check('not a web address', (await refused({ url: 'my game' })).includes('not a web address'))
  check('not https', (await refused({ url: 'http://gitlab.com/a/b' })).includes('https'))
  check('no name to sign changes with',
    (await refused({ url: 'https://gitlab.com/a/b', authorName: ' ' })).includes('name'))

  console.log('\n[tokens]')
  check('GitLab gets the token as oauth2',
    withToken('https://gitlab.com/a/b.git', 'tok') === 'https://oauth2:tok@gitlab.com/a/b.git')
  check('GitHub gets it as an access token',
    withToken('https://github.com/a/b', 'tok') === 'https://x-access-token:tok@github.com/a/b')
  check('no token, no change', withToken('https://gitlab.com/a/b', '') === 'https://gitlab.com/a/b')
  check('a token is never shown in a message',
    withoutCredentials("fatal: could not read from 'https://oauth2:secret@gitlab.com/a/b'") ===
      "fatal: could not read from 'https://gitlab.com/a/b'")

  fs.rmSync(base, { recursive: true, force: true })
  console.log(`\n${pass} passed, ${fail} failed`)
  if (fail > 0) process.exitCode = 1
}

main().catch((e) => {
  console.error(e)
  process.exitCode = 1
})
