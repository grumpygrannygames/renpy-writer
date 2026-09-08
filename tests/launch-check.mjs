/**
 * End-to-end check. Run with Electron, not node:
 *   npm run test:e2e
 *
 * Boots the built renderer with the real preload bridge and the real IPC
 * handlers, creates a throwaway project against copies of actual Ren'Py
 * scripts, then drives the UI the way a person would: open an episode, switch
 * to the writer, and confirm the screenplay rendered. Exits non-zero on
 * failure so it can gate a release.
 */
import { promises as fs, mkdirSync } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { app, BrowserWindow } from 'electron'
import { registerIpc } from './.ipc-bundle.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const out = path.join(here, '..', 'out')

/**
 * Settings of the suite's own, thrown away with the run.
 *
 * These tests deliberately damage and delete a projects.json to prove the app
 * survives it. Left to itself Electron picks a settings folder shared with
 * every other Electron app on the machine, and the app under test uses one
 * derived from its name -- so a suite that damages "the" registry is one
 * rename away from damaging somebody's real project list. It did exactly that
 * once, and the list was only recoverable because a copy happened to exist.
 *
 * Set before whenReady, which is the only time Electron accepts it.
 */
const settings = path.join(os.tmpdir(), `rpw-settings-${Date.now()}`)
mkdirSync(settings, { recursive: true })
app.setPath('userData', settings)
/**
 * The sample project that travels with the tests.
 *
 * It used to be a copy of somebody's actual game, which meant this suite only
 * ran on one machine. The sample is small and made up, but shaped the same
 * way: chapters under game/scripts, portraits declared with `image side`, and
 * a folder of stills to convert.
 */
const FIXTURE = path.resolve('tests', 'fixture')
const SAMPLE = path.join(FIXTURE, 'episodic')

let pass = 0
let fail = 0
const check = (name, ok, detail = '') => {
  if (ok) {
    pass++
    console.log(`  ok   ${name}`)
  } else {
    fail++
    console.log(`  FAIL ${name}${detail ? ' -- ' + detail : ''}`)
  }
}

/**
 * How long a moment is on this machine.
 *
 * Everything below gives the interface a moment to catch up before looking at
 * it. On a build server -- slower, busier, sharing a disk with whatever else
 * is running -- a moment is not as long as it needs to be, and checks start
 * failing for reasons that have nothing to do with the code. Rather than tune
 * each wait by hand, stretch them all there and leave them alone here.
 */
const PACE = process.env.CI ? 2 : 1

const sleep = (ms) => new Promise((r) => setTimeout(r, ms * PACE))

/**
 * A picture of a window, saved under the name given.
 *
 * Wrapped because `capturePage` asks the compositor for a frame and the
 * compositor is entitled to say no -- an occluded window, a GPU process
 * restarting, and it rejects with UnknownVizError. That rejection once went
 * unhandled and stalled the whole suite until the watchdog fired, which is a
 * great deal of consequence for a screenshot nobody was checking. Pictures are
 * a courtesy; nothing here is allowed to fail because one could not be taken.
 */
const shoot = async (contents, name) => {
  const file = path.join(os.tmpdir(), 'rpw-shots', name)
  try {
    const image = await contents.capturePage()
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, image.toPNG())
    console.log('  screenshot: ' + file)
  } catch (e) {
    console.log('  (no screenshot of ' + name + ': ' + (e?.message ?? String(e)) + ')')
  }
}

/**
 * Wait for something to become true in a page, rather than for a number of
 * milliseconds.
 *
 * A fixed wait is a guess about how fast the machine is, and on a slower one
 * -- a build server, a laptop doing something else -- the guess is wrong. That
 * is how a suite starts failing once in twenty runs with no change to explain
 * it, and passing again the moment anybody looks. Waiting for the thing itself
 * costs nothing when it is already there, and a genuine failure still fails,
 * just after the deadline instead of before it.
 */
const settle = async (contents, expression, ms = 20000) => {
  const deadline = Date.now() + ms
  for (;;) {
    let there = false
    try {
      there = await contents.executeJavaScript(`!!(${expression})`)
    } catch {
      there = false
    }
    if (there) return true
    if (Date.now() > deadline) return false
    await sleep(100)
  }
}

/**
 * The same idea inside a probe, where the waiting has to happen between a
 * click and the answer. Pasted inside the probes that need it, so the
 * declarations stay in the probe rather than becoming globals the next one
 * cannot declare again.
 */
const UNTIL = `
    const wait = (ms) => new Promise(r => setTimeout(r, ms * ${PACE}));
    const until = async (fn, ms = 15000) => {
      const deadline = Date.now() + ms;
      for (;;) {
        let value = null;
        try { value = fn(); } catch { value = null; }
        if (value) return value;
        if (Date.now() > deadline) return null;
        await wait(50);
      }
    };
`

/** A disposable Ren'Py project containing copies of real scripts. */
async function makeFixture() {
  const root = path.join(os.tmpdir(), `rpw-e2e-${Date.now()}`)
  const scripts = path.join(root, 'game', 'scripts')
  await fs.mkdir(scripts, { recursive: true })
  // script.rpy carries the Character() and `image side` definitions.
  for (const f of ['script.rpy', 'chapter_1.rpy', 'chapter_2.rpy']) {
    await fs.copyFile(path.join(SAMPLE, 'game', 'scripts', f), path.join(scripts, f))
  }

  // Portraits live under game/images/portraits/ while the script declares them
  // as "portraits/x.png"; copying them keeps that resolution under test.
  const portraits = path.join(root, 'game', 'images', 'portraits')
  await fs.mkdir(portraits, { recursive: true })
  const srcPortraits = path.join(SAMPLE, 'game', 'images', 'portraits')
  for (const f of await fs.readdir(srcPortraits)) {
    await fs.copyFile(path.join(srcPortraits, f), path.join(portraits, f))
  }
  const backgrounds = path.join(root, 'game', 'images', 'backgrounds')
  await fs.mkdir(backgrounds, { recursive: true })
  const srcBackgrounds = path.join(SAMPLE, 'game', 'images', 'backgrounds')
  for (const f of await fs.readdir(srcBackgrounds)) {
    await fs.copyFile(path.join(srcBackgrounds, f), path.join(backgrounds, f))
  }
  return root
}

// A hung page must not hang the suite; fail loudly instead.
const WATCHDOG_MS = 900000 * PACE
const watchdog = setTimeout(() => {
  console.log(`  FAIL harness timed out after ${WATCHDOG_MS / 1000}s`)
  console.log(`${pass} passed, ${fail + 1} failed`)
  app.exit(1)
}, WATCHDOG_MS)
watchdog.unref?.()

app.whenReady().then(async () => {
  registerIpc()
  const root = await makeFixture()

  /**
   * Shown, but never given focus.
   *
   * Shown, because a hidden window gives focus to nothing, so blur never fires
   * and click-to-edit appears to work even when it is broken. Not focused,
   * because a suite that takes eight minutes and steals the keyboard the
   * moment it starts is a suite nobody runs while doing anything else. The
   * window is opened with showInactive() once the page has loaded, which
   * renders and composites it without taking it to the front.
   */
  const win = new BrowserWindow({
    show: false,
    width: 1400,
    height: 900,
    webPreferences: {
      preload: path.join(out, 'preload', 'index.mjs'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      // Chromium throttles timers and stops dispatching scroll events in a
      // window it considers hidden, and one sitting behind another counts.
      // Without this, anything driven by scrolling silently never fires.
      backgroundThrottling: false
    }
  })

  const problems = []
  win.webContents.on('console-message', (event) => {
    if (event.level === 'warning' || event.level === 'error') {
      problems.push(`console: ${event.message} (${event.sourceId}:${event.lineNumber})`)
    }
  })
  win.webContents.on('did-fail-load', (_e, code, desc) => {
    problems.push(`did-fail-load: ${desc} (${code})`)
  })

  const js = async (code) => {
    try {
      return await win.webContents.executeJavaScript(code)
    } catch (e) {
      problems.push('executeJavaScript threw: ' + (e?.message ?? String(e)))
      return {}
    }
  }

  /**
   * A real press, not a synthetic event. Synthetic mousedown carries no default
   * action, so it cannot catch anything that depends on where the browser puts
   * focus afterwards — which is most click-to-edit behaviour.
   */
  const realClick = async (x, y) => {
    win.webContents.sendInputEvent({ type: 'mouseMove', x, y })
    win.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 })
    await sleep(60)
    win.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 })
    await sleep(400)
  }

  /** Where to press to hit an element, or null if it is not on screen. */
  const pointAt = (selector) =>
    js(
      '(() => {' +
      '  const el = document.querySelector(' + JSON.stringify(selector) + ');' +
      '  if (!el) return null;' +
      '  const b = el.getBoundingClientRect();' +
      '  if (b.width === 0 || b.height === 0) return null;' +
      '  return { x: Math.round(b.left + 8), y: Math.round(b.top + b.height / 2) };' +
      '})()'
    )

  const typeText = async (text) => {
    for (const ch of text) {
      win.webContents.sendInputEvent({ type: 'char', keyCode: ch })
      await sleep(12)
    }
  }

  await win.loadFile(path.join(out, 'renderer', 'index.html'))
  win.showInactive()
  await settle(win.webContents, "document.querySelector('.gate-card')")
  // A moment more: the gate is drawn before the project list arrives.
  await sleep(600)

  console.log('\n[shell]')
  const shell = await js(`(() => ({
    mounted: document.getElementById('root')?.childElementCount > 0,
    gate: !!document.querySelector('.gate-card'),
    heading: document.querySelector('.gate-card h1')?.textContent ?? null,
    apiMethods: window.api ? Object.keys(window.api).length : 0
  }))()`)
  check('React mounted', shell.mounted)
  check('project gate rendered', shell.gate)
  check('heading reads the app name', shell.heading === 'Ren’Py Writer', String(shell.heading))
  check('api exposes all 38 methods', shell.apiMethods === 38, String(shell.apiMethods))

  console.log('\n[a broken bridge says so]')
  {
    // The preload script is what the renderer reaches files through. When it
    // fails to load -- a sandboxed window, a half-written build -- the absence
    // used to be read as "this must be a browser", and the desktop app offered
    // a sign-in for a server that does not exist. That looks identical to
    // every project having vanished, and no amount of clicking fixes it.
    const broken = new BrowserWindow({
      show: false,
      width: 1100,
      height: 800,
      webPreferences: {
        preload: path.join(out, 'preload', 'index.mjs'),
        // The real app sets sandbox:false. Setting it true here is how a
        // preload that cannot load is reproduced on purpose.
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false
      }
    })
    await broken.loadFile(path.join(out, 'renderer', 'index.html'))
    await settle(broken.webContents, "document.querySelector('.gate-card .error')")
    const seen = await broken.webContents.executeJavaScript(`(() => {
      const err = document.querySelector('.gate-card .error');
      const box = err?.getBoundingClientRect();
      return {
        bridge: !!window.api,
        askedToSignIn: !!document.querySelector('input[type=password]'),
        message: err?.textContent ?? null,
        width: box ? Math.round(box.width) : 0,
        height: box ? Math.round(box.height) : 0
      };
    })()`)
    broken.destroy()

    check('the fixture really has no bridge', seen.bridge === false, String(seen.bridge))
    check('a desktop app with no bridge is not asked to sign in',
      seen.askedToSignIn === false, String(seen.askedToSignIn))
    check('it says the app failed to start, not that files are missing',
      /did not load/.test(seen.message ?? ''), String(seen.message).slice(0, 90))
    check('and reassures that the work is untouched',
      /untouched/.test(seen.message ?? ''), String(seen.message).slice(0, 120))
    check('the message is actually on screen',
      seen.width > 100 && seen.height > 10, seen.width + 'x' + seen.height)
  }

  console.log('\n[the project list survives a bad read]')
  // The registry is the only record that a project exists. These are the ways
  // it can go wrong, each of which used to arrive on screen as "No projects
  // yet" -- an invitation to re-add one project on top of the list that still
  // held all the others.
  const registryFile = path.join(app.getPath('userData'), 'projects.json')
  const registryBackup = registryFile + '.bak'
  const savedRegistry = await fs.readFile(registryFile, 'utf8').catch(() => null)
  const savedBackup = await fs.readFile(registryBackup, 'utf8').catch(() => null)

  const listing = () => js(`window.api.listProjects()`)
  const twoProjects = JSON.stringify({
    version: 1,
    projects: [
      { id: 'a', name: 'Alpha', renpyRoot: 'C:\\games\\alpha', lastOpenedAt: '2026-01-01T00:00:00Z' },
      { id: 'b', name: 'Beta', renpyRoot: 'C:\\games\\beta', lastOpenedAt: '2026-01-02T00:00:00Z' }
    ]
  })

  await fs.writeFile(registryFile, twoProjects, 'utf8')
  await fs.rm(registryBackup, { force: true })
  const healthy = await listing()
  check('a healthy list comes back whole',
    healthy.projects.length === 2 && !healthy.error, JSON.stringify(healthy))
  check('it says where it lives', healthy.path === registryFile, String(healthy.path))

  // A write leaves the previous version behind, which recovery leans on.
  await js(`window.api.removeProject('nobody')`)
  const backedUp = await fs.readFile(registryBackup, 'utf8').catch(() => null)
  check('writing keeps the previous version as a backup',
    (backedUp ?? '').includes('Alpha'), String(backedUp).slice(0, 60))

  // Truncated by a crash mid-write.
  await fs.writeFile(registryFile, '{"version":1,"projects":[{"id":"a"', 'utf8')
  const damaged = await listing()
  check('a truncated list is reported, not silently emptied', !!damaged.error,
    JSON.stringify(damaged))
  check('and is recovered from the backup',
    damaged.recovered === true && damaged.projects.length === 2, JSON.stringify(damaged))

  await fs.writeFile(registryFile, '', 'utf8')
  const empty = await listing()
  check('an empty file is reported as empty, not as no projects',
    (empty.error ?? '').includes('empty'), JSON.stringify(empty))
  check('the projects still come back from the backup', empty.projects.length === 2,
    JSON.stringify(empty.projects.map(p => p.name)))

  // The file gone but the backup still there. This is the likeliest way to
  // lose the list -- deleted, moved, quarantined, lost to a sync conflict --
  // and it used to be the one failure that did not even look at the backup.
  await fs.writeFile(registryBackup, twoProjects, 'utf8')
  await fs.rm(registryFile, { force: true })
  const vanished = await listing()
  check('a missing list is recovered from the backup',
    vanished.projects.length === 2 && vanished.recovered === true, JSON.stringify(vanished))
  check('and is not passed off as a fresh install',
    (vanished.error ?? '').includes('missing'), String(vanished.error))
  check('the projects come back by name',
    vanished.projects.map((p) => p.name).join(',') === 'Alpha,Beta',
    JSON.stringify(vanished.projects.map((p) => p.name)))

  // A genuinely empty list: no file, no backup, nothing to recover. This is
  // the one honest "no projects yet" -- and it has to say where it looked,
  // because that sentence reads identically whether the list really is empty
  // or the app is reading a different file than the one being edited. Without
  // the path there is no way to tell those apart from the screen.
  await fs.rm(registryFile, { force: true })
  await fs.rm(registryBackup, { force: true })
  const genuinely = await listing()
  check('a missing list with no backup is simply empty',
    genuinely.projects.length === 0 && !genuinely.error, JSON.stringify(genuinely))

  await js(`window.location.reload()`).catch(() => {})
  await sleep(1500)
  const emptyGate = await js(`(() => {
    const el = document.querySelector('.gate-path');
    const box = el?.getBoundingClientRect();
    return {
      text: el?.textContent ?? null,
      width: box ? Math.round(box.width) : 0,
      height: box ? Math.round(box.height) : 0,
      spills: el ? el.scrollWidth > el.clientWidth + 1 : null,
      card: Math.round(document.querySelector('.gate-card').getBoundingClientRect().right)
    };
  })()`)
  check('an empty list says which file it read',
    (emptyGate.text ?? '').includes('projects.json'), String(emptyGate.text))
  check('and names the real one, not a guess',
    (emptyGate.text ?? '').includes(app.getPath('userData')), String(emptyGate.text))
  check('the path is on screen and fits',
    emptyGate.width > 100 && emptyGate.height > 8 && emptyGate.spills === false,
    `${emptyGate.width}x${emptyGate.height} spills=${emptyGate.spills}`)

  // Unreadable with no backup to fall back on: the dangerous case.
  await fs.rm(registryBackup, { force: true })
  await fs.writeFile(registryFile, 'not json at all', 'utf8')
  const stranded = await listing()
  check('an unreadable list with no backup still reports the problem',
    !!stranded.error && stranded.recovered !== true, JSON.stringify(stranded))

  // Adding a project now must not replace the file with a one-entry list.
  const clobberRoot = path.join(os.tmpdir(), `rpw-clobber-${Date.now()}`)
  await fs.mkdir(path.join(clobberRoot, 'game', 'scripts'), { recursive: true })
  await js(`(async () => {
    try {
      await window.api.createProject({
        name: 'Would Clobber', renpyRoot: ${JSON.stringify(clobberRoot)},
        settings: { sourceLanguage: 'cs', targetLanguage: 'en', expressionsEnabled: false, linear: true, scriptDir: 'scripts' }
      });
      return 'allowed';
    } catch (e) {
      return String(e.message ?? e);
    }
  })()`)
  const afterAttempt = await fs.readFile(registryFile, 'utf8')
  check('adding a project on top of an unreadable list leaves the file alone',
    afterAttempt === 'not json at all', afterAttempt.slice(0, 40))
  await fs.rm(clobberRoot, { recursive: true, force: true })

  // The gate must not offer its empty-state line when something went wrong.
  await win.webContents.reload()
  await sleep(1200)
  const gate = await js(`(() => {
    const text = document.querySelector('.gate-card')?.textContent ?? '';
    return {
      saysNone: text.includes('No projects yet'),
      error: document.querySelector('.error')?.textContent ?? null,
      retry: !!document.querySelector('.error .retry')
    };
  })()`)
  check('the gate does not claim there are no projects', gate.saysNone === false,
    String(gate.saysNone))
  check('it explains what happened instead',
    (gate.error ?? '').includes('could not be understood'), String(gate.error))
  check('it names the file to look at', (gate.error ?? '').includes('projects.json'),
    String(gate.error))
  check('and offers to try again', gate.retry === true)

  // A missing file is a new install, and says nothing alarming.
  await fs.rm(registryFile, { force: true })
  await fs.rm(registryBackup, { force: true })
  const fresh = await listing()
  check('a first run reports no projects and no problem',
    fresh.projects.length === 0 && !fresh.error, JSON.stringify(fresh))

  if (savedRegistry !== null) await fs.writeFile(registryFile, savedRegistry, 'utf8')
  if (savedBackup !== null) await fs.writeFile(registryBackup, savedBackup, 'utf8')
  await win.webContents.reload()
  await sleep(1000)

  console.log('\n[the interface runs on a transport that is not Electron]')
  // The point of the seam: nothing above src/renderer/src/api.ts knows what is
  // answering. Here a plain object stands in for the preload bridge -- the same
  // shape a browser build would fill with HTTP calls. If any component reached
  // for window.api directly, the real registry would show through instead.
  const foreign = await js(`(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms * ${PACE}));
    if (!window.renpyWriter) return { stage: 'no host hook' };

    const calls = [];
    window.renpyWriter.setApi(new Proxy({}, {
      get: (_t, name) => (...args) => {
        calls.push(String(name));
        if (name === 'listProjects') {
          return Promise.resolve({
            path: '/nowhere/projects.json',
            projects: [{
              id: 'f1', name: 'Somewhere Else', renpyRoot: '/srv/games/elsewhere',
              lastOpenedAt: '2026-01-01T00:00:00Z'
            }]
          });
        }
        return Promise.resolve(null);
      }
    }));
    await wait(1200);

    const names = Array.from(document.querySelectorAll('.project-item .name')).map(e => e.textContent);
    const paths = Array.from(document.querySelectorAll('.project-item .path')).map(e => e.textContent);
    window.renpyWriter.setApi(null);
    await wait(1200);
    const afterNames = Array.from(document.querySelectorAll('.project-item .name')).map(e => e.textContent);
    return { stage: 'ok', names, paths, calls, backToReal: afterNames.length };
  })()`)

  check('the app offers a hook for installing a transport', foreign.stage === 'ok',
    String(foreign.stage))
  check('the gate shows only what the stand-in returned',
    JSON.stringify(foreign.names) === '["Somewhere Else"]',
    JSON.stringify((foreign.names ?? []).slice(0, 3)))
  check('including a path no Electron machine would have',
    JSON.stringify(foreign.paths) === '["/srv/games/elsewhere"]',
    JSON.stringify((foreign.paths ?? []).slice(0, 3)))
  check('the calls went to the stand-in, not the bridge',
    (foreign.calls ?? []).includes('listProjects'),
    JSON.stringify((foreign.calls ?? []).slice(0, 5)))
  check('removing it hands the app back to the real bridge',
    (foreign.backToReal ?? 0) !== 1, String(foreign.backToReal))

  console.log('\n[project]')
  const created = await js(`(async () => {
    const r = ${JSON.stringify(root)};
    const check = await window.api.checkRoot(r);
    const opened = await window.api.createProject({
      name: 'E2E Fixture',
      renpyRoot: r,
      settings: { sourceLanguage: 'cs', targetLanguage: 'en', expressionsEnabled: true, linear: false, scriptDir: 'scripts' }
    });
    return { valid: check.valid, candidates: check.scriptDirCandidates, unregistered: opened.unregisteredFiles, episodes: opened.episodes.length };
  })()`)
  check('fixture validates as a Ren’Py root', created.valid)
  check('detects game/scripts', created.candidates.includes('scripts'), String(created.candidates))
  check('reports all three scripts as unadopted', created.unregistered.length === 3, String(created.unregistered))
  check('starts with no episodes', created.episodes === 0)

  const imported = await js(`(async () => {
    const opened = await window.api.createEpisode({
      renpyRoot: ${JSON.stringify(root)}, mode: 'import', name: 'Chapter 2', fileName: 'chapter_2.rpy'
    });
    return { episodes: opened.episodes.length, beats: opened.beats.length, unregistered: opened.unregisteredFiles.length };
  })()`)
  check('import adopts the file as an episode', imported.episodes === 1)
  check('labels became beats', imported.beats === 9, String(imported.beats))
  check('adopted file leaves the unadopted list', imported.unregistered === 2, String(imported.unregistered))

  // Reload so the React tree picks up the project from the registry.
  await win.webContents.reload()
  await sleep(1200)
  await js(`document.querySelector('.project-item')?.click()`)
  await sleep(1200)

  console.log('\n[outline]')
  const outline = await js(`(() => ({
    project: document.querySelector('.switcher-name')?.textContent ?? null,
    episodes: document.querySelectorAll('.episode-row').length,
    beats: document.querySelectorAll('.beat-row').length,
    fallthrough: Array.from(document.querySelectorAll('.beat-row .kind')).filter(e => e.textContent.includes('falls through')).length
  }))()`)
  check('project name in the switcher', outline.project === 'E2E Fixture', String(outline.project))
  check('one episode listed', outline.episodes === 1, String(outline.episodes))
  check('nine beats listed', outline.beats === 9, String(outline.beats))
  check('fall-through beats flagged', outline.fallthrough === 4, String(outline.fallthrough))

  console.log('\n[writer view]')
  await js(`document.querySelector('.episode-row')?.click()`)
  await sleep(900)
  const started = Date.now()
  await js(`Array.from(document.querySelectorAll('.mode-switch button')).find(b => b.textContent === 'Writer')?.click()`)
  await sleep(900)
  const renderMs = Date.now() - started

  // Hand the page the file it is displaying, so the check below can compare
  // what is on screen against what is actually in the script.
  await js(`(async () => {
    window.__e2eSource = await window.api.readEpisode(${JSON.stringify(root)}, 'chapter_2.rpy');
  })()`)

  const writer = await js(`(() => ({
    present: !!document.querySelector('.writer'),
    labels: document.querySelectorAll('.blk-label').length,
    dialogue: document.querySelectorAll('.blk-dialogue').length,
    actions: document.querySelectorAll('.blk-action').length,
    raw: document.querySelectorAll('.blk-raw').length,
    firstLabel: document.querySelector('.blk-label span')?.textContent ?? null,
    firstSpeaker: document.querySelector('.blk-character-name')?.textContent ?? null,
    expressionPickers: document.querySelectorAll('.expr-trigger').length,
    // Taken from the file rather than hardcoded: these are living scripts and
    // a line quoted here stops existing the moment it gets translated.
    sampleLine: (() => {
      const shown = Array.from(document.querySelectorAll('.blk-text .blk-view'))
        .map(e => e.textContent.trim()).filter(t => t.length > 12);
      const source = window.__e2eSource ?? '';
      const inFile = [...source.matchAll(/"([^"\]{12,})"/g)].map(m => m[1]);
      return inFile.find(t => shown.includes(t)) ?? null;
    })()
  }))()`)

  check('writer view rendered', writer.present)
  check('labels rendered as beats', writer.labels === 9, String(writer.labels))
  check('dialogue blocks rendered', writer.dialogue > 100, String(writer.dialogue))
  check('action lines rendered', writer.actions > 0, String(writer.actions))
  check('code lines hidden by default', writer.raw === 0, String(writer.raw))
  check('first beat is the opening label', writer.firstLabel === 'ch2_arrival', String(writer.firstLabel))
  check('character names shown uppercase', writer.firstSpeaker === 'AVA', String(writer.firstSpeaker))
  check('expression pickers shown when enabled', writer.expressionPickers > 0, String(writer.expressionPickers))
  check('dialogue on screen matches the file', writer.sampleLine !== null, String(writer.sampleLine))
  check(`writer renders in under 2s (${renderMs}ms)`, renderMs < 2000, `${renderMs}ms`)

  const toggled = await js(`(() => {
    const cb = document.querySelector('.wt-toggle input'); cb.click();
    return document.querySelectorAll('.blk-raw').length;
  })()`)
  check('showing code lines reveals raw statements', toggled > 20, String(toggled))

  console.log('\n[layout, completion, autosave]')
  const layout = await js(`(() => {
    const page = document.querySelector('.writer-page');
    const area = document.querySelector('.editor-area');
    return { pageW: page.getBoundingClientRect().width, areaW: area.getBoundingClientRect().width,
             bg: getComputedStyle(document.querySelector('.writer')).backgroundColor };
  })()`)
  check('writer fills the editor area',
    layout.pageW / layout.areaW > 0.95, Math.round(layout.pageW) + ' of ' + Math.round(layout.areaW) + 'px')
  check('writer uses the dark ground', layout.bg === 'rgb(22, 22, 26)', layout.bg)

  // Tab on a partial name should complete it rather than move on.
  const completed = await js(`(async () => {
    const name = document.querySelector('.blk-character-name');
    name.click();
    await new Promise(r => setTimeout(r, 120));
    const input = document.querySelector('.blk-character-input');
    if (!input) return { error: 'no input' };
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, 'av');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise(r => setTimeout(r, 120));
    const suggestions = Array.from(document.querySelectorAll('.speaker-suggest .ss-var')).map(e => e.textContent);
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    await new Promise(r => setTimeout(r, 120));
    const after = document.querySelector('.blk-character-input')?.value ?? null;
    const stillFocused = document.activeElement === document.querySelector('.blk-character-input');
    return { suggestions, after, stillFocused };
  })()`)
  check('typing a prefix offers suggestions',
    Array.isArray(completed.suggestions) && completed.suggestions.length > 0,
    JSON.stringify(completed.suggestions))
  check('Tab completes to the first suggestion', completed.after === 'ava', String(completed.after))
  check('Tab keeps focus in the character field so it can be corrected', completed.stillFocused === true)

  // The name a character is known by is often not the name the script sorts
  // them under. Cora Vale is `cora` to the engine, and somebody thinking of
  // her as Vale had no way to reach her.
  const byLaterWord = await js(`(async () => {${UNTIL}
    const input = document.querySelector('.blk-character-input');
    if (!input) return { stage: 'no input' };
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    const offer = async (text) => {
      setter.call(input, text);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await wait(250);
      return Array.from(document.querySelectorAll('.speaker-suggest .ss-var')).map(e => e.textContent);
    };
    return {
      stage: 'ok',
      surname: await offer('vale'),
      middle: await offer('emor'),
      front: await offer('av'),
      nobody: await offer('zzzz')
    };
  })()`)

  check('a later word in the name finds them',
    (byLaterWord.surname ?? []).includes('cora'), JSON.stringify(byLaterWord.surname))
  check('and so does the middle of a script name',
    (byLaterWord.middle ?? []).includes('nico_memory'), JSON.stringify(byLaterWord.middle))
  check('while the start of one still comes first',
    (byLaterWord.front ?? [])[0] === 'ava', JSON.stringify(byLaterWord.front))
  check('and a name nobody has offers nobody',
    (byLaterWord.nobody ?? []).length === 0, JSON.stringify(byLaterWord.nobody))

  await js(`document.querySelector('.blk-character-input')?.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
  await sleep(300)

  // Autosave: edit a line and wait, without pressing Ctrl+S.
  // The window is created hidden, so the document has no focus and
  // element.blur() is a no-op in Chromium; dispatch focusout instead, which is
  // what a real click-away produces.
  const autosaved = await js(`(async () => {
    const file = 'chapter_2.rpy';
    const before = await window.api.readEpisode(${JSON.stringify(root)}, file);
    const block = document.querySelectorAll('.blk-dialogue')[1];
    const view = block.querySelector('.blk-text .blk-view');
    const originalText = view.textContent;
    view.click();
    await new Promise(r => setTimeout(r, 200));
    const ta = block.querySelector('.blk-input');
    if (!ta) return { stage: 'no textarea' };
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(ta, 'AUTOSAVE PROBE');
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    ta.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    await new Promise(r => setTimeout(r, 300));
    const shownAfterEdit = block.querySelector('.blk-text .blk-view')?.textContent ?? null;
    const statusMid = document.querySelector('.statusbar')?.textContent ?? '';
    await new Promise(r => setTimeout(r, 2600));
    const after = await window.api.readEpisode(${JSON.stringify(root)}, file);
    return {
      stage: 'ran', originalText, shownAfterEdit, statusMid,
      changed: before !== after,
      hasProbe: after.includes('AUTOSAVE PROBE'),
      probeLine: after.split(String.fromCharCode(10)).find((l) => l.includes('AUTOSAVE PROBE')) ?? null,
      speakerKept: /\\b(?:ava|ava_thoughts|ben|cora|nico|dev|quinn)(?: \\w+)? "AUTOSAVE PROBE"/
        .test(after),
      lineCountSame: before.split(String.fromCharCode(10)).length === after.split(String.fromCharCode(10)).length,
      status: document.querySelector('.statusbar')?.textContent ?? ''
    };
  })()`)
  check('the edit shows in the writer', autosaved.shownAfterEdit === 'AUTOSAVE PROBE', String(autosaved.shownAfterEdit))
  check('an edit reaches disk without Ctrl+S', autosaved.changed === true, autosaved.stage)
  check('the edited text is what landed', autosaved.hasProbe === true)
  check('the speaker survived the edit', autosaved.speakerKept === true,
    String(autosaved.probeLine))
  check('no lines were added or lost', autosaved.lineCountSame === true)
  check('status bar shows saved, not unsaved',
    /Saved/.test(autosaved.status) && !/Unsaved/.test(autosaved.status), autosaved.status)

  console.log('\n[inline markup]')
  const markup = await js(`(async () => {
    const block = document.querySelectorAll('.blk-dialogue')[3];
    const view = block.querySelector('.blk-text .blk-view');
    view.click();
    await new Promise(r => setTimeout(r, 200));
    const ta = block.querySelector('.blk-input');
    if (!ta) return { stage: 'no textarea' };
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(ta, 'hello brave world');
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    ta.setSelectionRange(6, 11);           // select "brave"
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'b', ctrlKey: true, bubbles: true }));
    await new Promise(r => setTimeout(r, 150));
    const afterBold = ta.value;
    const selAfter = [ta.selectionStart, ta.selectionEnd];
    // toggling again on the same selection should remove it
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'b', ctrlKey: true, bubbles: true }));
    await new Promise(r => setTimeout(r, 150));
    const afterUnbold = ta.value;
    // re-apply, then italic on top, then commit
    ta.setSelectionRange(6, 11);
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'i', ctrlKey: true, bubbles: true }));
    await new Promise(r => setTimeout(r, 150));
    const afterItalic = ta.value;
    ta.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    await new Promise(r => setTimeout(r, 300));
    const rendered = block.querySelector('.blk-text .blk-view');
    const shownText = rendered ? rendered.textContent : null;
    const italicSpans = rendered ? Array.from(rendered.querySelectorAll('span'))
      .filter(sp => getComputedStyle(sp).fontStyle === 'italic').map(sp => sp.textContent) : [];
    await new Promise(r => setTimeout(r, 2200));
    const onDisk = await window.api.readEpisode(${JSON.stringify(root)}, 'chapter_2.rpy');
    return { afterBold, selAfter, afterUnbold, afterItalic, shownText, italicSpans,
             diskHasItalic: onDisk.includes('{i}brave{/i}') };
  })()`)
  check('Ctrl+B wraps the selection in {b}', markup.afterBold === 'hello {b}brave{/b} world', String(markup.afterBold))
  check('selection still covers the same word', JSON.stringify(markup.selAfter) === '[9,14]', JSON.stringify(markup.selAfter))
  check('Ctrl+B again removes it', markup.afterUnbold === 'hello brave world', String(markup.afterUnbold))
  check('Ctrl+I wraps the selection in {i}', markup.afterItalic === 'hello {i}brave{/i} world', String(markup.afterItalic))
  check('tags are not shown as literal text', markup.shownText === 'hello brave world', String(markup.shownText))
  check('the tagged word actually renders italic',
    JSON.stringify(markup.italicSpans) === '["brave"]', JSON.stringify(markup.italicSpans))
  check('markup survives to disk', markup.diskHasItalic === true)

  console.log('\n[outline collapse]')
  const collapse = await js(`(async () => {
    // Opening an episode also folds it, so normalise to expanded first.
    if (document.querySelectorAll('.beat-row').length === 0) {
      document.querySelector('.ep-caret').click();
      await new Promise(r => setTimeout(r, 150));
    }
    const before = document.querySelectorAll('.beat-row').length;
    document.querySelector('.ep-caret').click();
    await new Promise(r => setTimeout(r, 150));
    const after = document.querySelectorAll('.beat-row').length;
    const badge = document.querySelector('.ep-count')?.textContent ?? null;
    document.querySelector('.ep-caret').click();
    await new Promise(r => setTimeout(r, 150));
    // Clicking the name (not the caret) should fold it too.
    const nameToggled = [];
    nameToggled.push(document.querySelectorAll('.beat-row').length);
    document.querySelector('.episode-row').click();
    await new Promise(r => setTimeout(r, 250));
    nameToggled.push(document.querySelectorAll('.beat-row').length);
    document.querySelector('.episode-row').click();
    await new Promise(r => setTimeout(r, 250));
    nameToggled.push(document.querySelectorAll('.beat-row').length);
    return { before, after, badge, restored: nameToggled[0], nameToggled };
  })()`)
  check('collapsing hides the beats', collapse.before === 9 && collapse.after === 0,
    collapse.before + ' -> ' + collapse.after)
  check('collapsed episode shows a beat count', collapse.badge === '9', String(collapse.badge))
  check('expanding brings them back', collapse.restored === 9, String(collapse.restored))
  check('clicking the episode name folds and unfolds it',
    JSON.stringify(collapse.nameToggled) === '[9,0,9]', JSON.stringify(collapse.nameToggled))

  console.log('\n[character variants]')
  const variants = await js(`(() => {
    const names = Array.from(document.querySelectorAll('.blk-character-name'));
    const withVariant = names.filter(n => n.querySelector('.blk-variant'));
    return {
      total: names.length,
      variantCount: withVariant.length,
      sample: withVariant.slice(0, 3).map(n => n.textContent),
      titles: withVariant.slice(0, 3).map(n => n.getAttribute('title'))
    };
  })()`)
  check('some speakers are marked as variants', variants.variantCount > 0, JSON.stringify(variants.sample))
  check('variant markers only appear on real variants',
    Array.isArray(variants.titles) && variants.titles.every(t => typeof t === 'string' && t.includes('_')),
    JSON.stringify(variants.titles))
  check('most speakers carry no badge', variants.variantCount < variants.total,
    variants.variantCount + ' of ' + variants.total)

  console.log('\n[expression preview]')
  const preview = await js(`(async () => {
    const trigger = document.querySelector('.expr-trigger');
    if (!trigger) return { stage: 'no picker' };
    trigger.click();
    await new Promise(r => setTimeout(r, 250));
    const options = Array.from(document.querySelectorAll('.expr-list li')).map(li => li.textContent);
    const target = Array.from(document.querySelectorAll('.expr-list li')).find(li => li.textContent === 'serious')
      || document.querySelectorAll('.expr-list li')[1];
    target.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false }));
    let img = null;
    for (let i = 0; i < 20; i++) {
      img = document.querySelector('.expr-preview img');
      if (img && img.src.startsWith('data:image')) break;
      await new Promise(r => setTimeout(r, 150));
    }
    const src = img ? img.src.slice(0, 21) : null;
    const complete = img ? img.complete && img.naturalWidth > 0 : false;
    target.click();
    await new Promise(r => setTimeout(r, 250));
    return { options, src, complete, chosen: document.querySelector('.expr-trigger')?.textContent ?? null };
  })()`)
  check('expression list is populated', Array.isArray(preview.options) && preview.options.length > 3,
    JSON.stringify((preview.options || []).slice(0, 5)))
  check('hovering an expression loads a portrait', preview.src === 'data:image/png;base64', String(preview.src))
  check('the portrait actually decodes', preview.complete === true)
  check('picking an expression sets it', typeof preview.chosen === 'string' && preview.chosen.length > 0,
    String(preview.chosen))

  console.log('\n[expression preview dismissal]')
  const dismissal = await js(`(async () => {
    Array.from(document.querySelectorAll('.tab')).find(t => t.textContent.indexOf('chapter_2') !== -1)?.click();
    await new Promise(r => setTimeout(r, 400));
    Array.from(document.querySelectorAll('.mode-switch button')).find(b => b.textContent === 'Writer')?.click();
    await new Promise(r => setTimeout(r, 800));

    // Ava is the one with a full set of portraits: a picker for a character
    // with none would never show a preview at all.
    const block = Array.from(document.querySelectorAll('.blk-dialogue')).find(
      (b) => b.querySelector('.blk-character-name')?.textContent?.startsWith('AVA')
    );
    const trigger = block?.querySelector('.expr-trigger');
    if (!trigger) return { stage: 'no picker for Ava' };
    trigger.click();
    await new Promise(r => setTimeout(r, 300));

    const options = document.querySelectorAll('.expr-list li');
    if (options.length < 2) return { stage: 'Ava has no expressions' };

    // The preview appears as soon as the list opens, showing the default
    // portrait; hovering swaps which one is shown.
    let shown = false;
    for (let i = 0; i < 25; i++) {
      await new Promise(r => setTimeout(r, 150));
      if (document.querySelector('.expr-preview img')) { shown = true; break; }
    }
    const option = options[1];
    option.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false }));
    await new Promise(r => setTimeout(r, 200));

    option.click();
    await new Promise(r => setTimeout(r, 250));
    return {
      stage: 'ok',
      shownOnHover: shown,
      listClosed: !document.querySelector('.expr-list'),
      previewGone: !document.querySelector('.expr-preview')
    };
  })()`)
  check('opening the picker shows a portrait', dismissal.shownOnHover === true, String(dismissal.stage))
  check('picking one closes the list', dismissal.listClosed === true)
  check('and the preview goes with it', dismissal.previewGone === true)

  console.log('\n[writer <-> code position sync]')
  // Synthetic scrolling cannot be used here: Chromium dispatches no scroll
  // events for a window that is hidden or parked offscreen, so the anchor is
  // driven through the outline instead. centreIndex is unit tested separately.
  const sync = await js(`(async () => {
    const clickMode = (name) => Array.from(document.querySelectorAll('.mode-switch button'))
      .find(b => b.textContent === name).click();
    const lnOf = () => {
      const m = document.querySelector('.statusbar').textContent.match(/Ln ([0-9]+)/);
      return m ? Number(m[1]) : null;
    };

    // Jump to a beat well down the file.
    const beats = Array.from(document.querySelectorAll('.beat-row'));
    beats[5].click();
    await new Promise(r => setTimeout(r, 900));
    const writerLine = lnOf();
    const writerHeading = document.querySelector('.blk-label span')?.textContent ?? null;

    clickMode('Code');
    await new Promise(r => setTimeout(r, 1400));
    const codeLine = lnOf();
    const cmScroller = document.querySelector('.cm-scroller');
    const scrolled = cmScroller ? cmScroller.scrollTop : null;

    clickMode('Writer');
    await new Promise(r => setTimeout(r, 1400));
    const backLine = lnOf();
    return { writerLine, writerHeading, codeLine, scrolled, backLine };
  })()`)
  check('jumping to a beat sets the anchor', sync.writerLine !== null && sync.writerLine > 100,
    String(sync.writerLine))
  check('code view opens on the same line', sync.codeLine === sync.writerLine,
    'writer ' + sync.writerLine + ' vs code ' + sync.codeLine)
  check('code view actually scrolled there', sync.scrolled !== null && sync.scrolled > 100,
    String(sync.scrolled))
  check('switching back returns to the same place', sync.backLine === sync.writerLine,
    sync.writerLine + ' -> ' + sync.backLine)

  // The half of that journey the check above cannot see. The writer draws
  // dialogue and headings; `scene`, `show` and `if` are code, and code is not
  // drawn there. So the line the code view was looking at very often does not
  // exist in the writer at all -- and asking to scroll to a line that is not
  // there scrolls nowhere, which is how switching views landed back at the top
  // of a file somebody was seven hundred lines into.
  const acrossCode = await js(`(async () => {${UNTIL}
    const lnOf = () => {
      const m = document.querySelector('.statusbar')?.textContent.match(/Ln ([0-9]+)/);
      return m ? Number(m[1]) : null;
    };
    const clickMode = (name) => Array.from(document.querySelectorAll('.mode-switch button'))
      .find(b => b.textContent === name)?.click();
    // Chromium dispatches no scroll event of its own for this window, so the
    // listener the app installed is poked by hand.
    const scrollTo = async (el, top) => {
      el.scrollTop = top;
      el.dispatchEvent(new WheelEvent('wheel', { bubbles: true }));
      el.dispatchEvent(new Event('scroll'));
      await wait(500);
    };

    clickMode('Writer');
    await until(() => document.querySelector('.writer-page [data-line]'));
    const page = document.querySelector('.writer-page');
    const drawn = Array.from(page.querySelectorAll('[data-line]')).map(e => Number(e.dataset.line));
    const drawnSet = new Set(drawn);
    // A line of the file the writer does not draw. Aimed at rather than
    // stumbled upon: the sample is nearly all dialogue.
    const wanted = drawn.length
      ? Array.from({ length: 400 }, (_, i) => i + 1).find(n => !drawnSet.has(n) && n > 10) ?? null
      : null;
    if (wanted === null) return { stage: 'every line is drawn' };

    clickMode('Code');
    const cm = await until(() => document.querySelector('.cm-scroller'));
    if (!cm) return { stage: 'no code view' };
    const lines = Number((document.querySelector('.statusbar')?.textContent
      .match(/([0-9]+) lines/) || [])[1] || 0);
    if (!lines) return { stage: 'no line count' };

    const lineHeight = cm.scrollHeight / lines;
    for (let tries = 0; tries < 6; tries++) {
      const ln = lnOf();
      if (tries > 0 && ln === wanted) break;
      const top = tries === 0
        ? (wanted - 1) * lineHeight - cm.clientHeight / 2
        : cm.scrollTop + (wanted - (ln ?? 1)) * lineHeight;
      await scrollTo(cm, Math.max(0, Math.round(top)));
    }
    const parked = lnOf();

    clickMode('Writer');
    await until(() => document.querySelector('.writer-page'));
    await wait(900);
    return {
      stage: 'ok', wanted, parked,
      parkedIsDrawn: drawnSet.has(parked),
      nearestAbove: drawn.filter(l => l <= parked).pop() ?? null,
      backLine: lnOf(),
      backScroll: document.querySelector('.writer-page')?.scrollTop ?? null
    };
  })()`)

  check('the code view can be parked on a line the writer does not draw',
    acrossCode.stage === 'ok' && acrossCode.parkedIsDrawn === false,
    JSON.stringify(acrossCode))
  check('and the writer opens at the block that line belongs to',
    acrossCode.backLine === acrossCode.nearestAbove,
    'nearest ' + acrossCode.nearestAbove + ' vs ' + acrossCode.backLine)
  check('rather than at the top of the file', (acrossCode.backScroll ?? 0) > 100,
    String(acrossCode.backScroll))

  console.log('\n[finding words]')
  const finding = await js(`(async () => {${UNTIL}
    const setVal = (el, v) => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(el, v);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    };
    const key = (el, k, extra) => el.dispatchEvent(
      new KeyboardEvent('keydown', Object.assign({ key: k, bubbles: true }, extra || {})));
    const clickMode = (name) => Array.from(document.querySelectorAll('.mode-switch button'))
      .find(b => b.textContent === name)?.click();

    clickMode('Writer');
    await until(() => document.querySelector('.writer-page [data-line]'));
    document.querySelector('.writer-page').scrollTop = 0;
    await wait(300);

    key(window, 'f', { ctrlKey: true });
    const bar = await until(() => document.querySelector('.find-bar'));
    if (!bar) return { stage: 'no bar in the writer' };
    const focused = document.activeElement === document.querySelector('.find-input');

    setVal(document.querySelector('.find-input'), 'beat 9');
    await wait(700);
    const count = document.querySelector('.find-count')?.textContent ?? null;
    const hit = !!document.querySelector('.hit-current');
    const marked = document.querySelectorAll('.hit-found').length;
    const scrolled = document.querySelector('.writer-page')?.scrollTop ?? 0;

    // Held open here so it can be photographed; the rest follows below.
    return { stage: 'open', focused, count, hit, marked, scrolled };
  })()`)

  check('Ctrl+F opens a find bar in the writer', finding.stage === 'open',
    JSON.stringify(finding).slice(0, 200))
  check('with the field already focused', finding.focused === true, String(finding.focused))
  check('it counts what it found', /^1 of \d+$/.test(finding.count ?? ''), String(finding.count))
  check('marks every hit', (finding.marked ?? 0) > 0, String(finding.marked))
  check('and brings the first one on screen', (finding.scrolled ?? 0) > 0, String(finding.scrolled))

  // A search that finds nothing, or highlights nothing, looks perfectly well
  // in the DOM. This is the only check that would notice.
  await shoot(win.webContents, 'find-bar.png')

  const stepping = await js(`(async () => {${UNTIL}
    const setVal = (el, v) => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(el, v);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    };
    const key = (el, k, extra) => el.dispatchEvent(
      new KeyboardEvent('keydown', Object.assign({ key: k, bubbles: true }, extra || {})));
    const clickMode = (name) => Array.from(document.querySelectorAll('.mode-switch button'))
      .find(b => b.textContent === name)?.click();
    if (!document.querySelector('.find-input')) return { stage: 'the bar closed itself' };

    key(document.querySelector('.find-input'), 'Enter');
    await wait(500);
    const afterEnter = document.querySelector('.find-count')?.textContent ?? null;
    key(document.querySelector('.find-input'), 'Enter', { shiftKey: true });
    await wait(500);
    const afterBack = document.querySelector('.find-count')?.textContent ?? null;

    setVal(document.querySelector('.find-input'), 'nobody wrote this');
    await wait(600);
    const none = document.querySelector('.find-count')?.textContent ?? null;

    key(document.querySelector('.find-input'), 'Escape');
    await wait(400);
    const closed = !document.querySelector('.find-bar');
    const stillMarked = document.querySelectorAll('.hit-found, .hit-current').length;

    // And the same keystroke in the other view.
    clickMode('Code');
    await until(() => document.querySelector('.cm-scroller'));
    const cm = document.querySelector('.cm-scroller');
    // Let the view settle where the writer left it before moving it. Switching
    // views carries the reading position across, and CodeMirror applies that
    // scroll in its own measure pass -- park it any sooner and the arriving
    // scroll puts it straight back.
    await wait(1200);

    // Then a long way from the first match. The code view opens where the
    // writer was, which is on top of it, and a search with nothing to scroll
    // to proves nothing about scrolling.
    cm.scrollTop = Math.round(cm.scrollHeight * 0.9);
    cm.dispatchEvent(new Event('scroll'));
    await wait(700);
    const parkedLine = Number((document.querySelector('.statusbar')?.textContent
      .match(/Ln ([0-9]+)/) || [])[1]) || 0;
    key(window, 'f', { ctrlKey: true });
    const codeBar = await until(() => document.querySelector('.find-bar'));
    if (!codeBar) return { stage: 'no bar in the code view', count, closed };
    setVal(document.querySelector('.find-input'), 'beat 9');
    await wait(900);
    const codeCount = document.querySelector('.find-count')?.textContent ?? null;

    // What the code view is actually looking at now, which is the thing that
    // matters however many pixels it took to get there. Written without a
    // single backslash: this is inside a template literal, where an escape
    // like the one for a newline becomes a real newline, and a regular
    // expression containing one of those does not parse.
    const bar = document.querySelector('.statusbar')?.textContent ?? '';
    const file = (bar.match(/([a-z0-9_]+.rpy)/) || [])[1] ?? null;
    const source = file ? await window.api.readEpisode(${JSON.stringify(root)}, file) : '';
    const landedLine = Number((bar.match(/Ln ([0-9]+)/) || [])[1]) || 0;
    const landedOn = source.split(String.fromCharCode(10))[landedLine - 1] ?? null;

    key(document.querySelector('.find-input'), 'Escape');
    await wait(400);

    return {
      stage: 'ok', afterEnter, afterBack, none, closed, stillMarked,
      codeCount, parkedLine, landedLine, landedOn
    };
  })()`)

  check('the bar stays put while it is worked with', stepping.stage === 'ok',
    JSON.stringify(stepping).slice(0, 200))
  check('Enter goes to the next', /^2 of \d+$/.test(stepping.afterEnter ?? ''),
    String(stepping.afterEnter))
  check('and Shift+Enter comes back', /^1 of \d+$/.test(stepping.afterBack ?? ''),
    String(stepping.afterBack))
  check('a word nobody wrote says so plainly', stepping.none === 'None', String(stepping.none))
  check('Escape closes it', stepping.closed === true, String(stepping.closed))
  check('and takes the highlighting with it', stepping.stillMarked === 0,
    String(stepping.stillMarked))
  check('the same keystroke works in the code view',
    /^1 of \d+$/.test(stepping.codeCount ?? ''), String(stepping.codeCount))
  // Judged by which line it ends up on, not by how many pixels it travelled:
  // CodeMirror draws only what is on screen, so its scroll height is an
  // estimate that grows as you move through the file and says nothing about
  // distance.
  check('and moves the source away from where it was parked',
    (stepping.landedLine ?? 0) > 0 && stepping.landedLine !== stepping.parkedLine,
    'parked on ' + stepping.parkedLine + ', landed on ' + stepping.landedLine)
  check('onto the line that was found',
    /beat 9/i.test(stepping.landedOn ?? ''), String(stepping.landedOn))

  console.log('\n[character profiles]')
  const prof = await js(`(async () => {
    const toggle = Array.from(document.querySelectorAll('button')).find(b => b.textContent === 'Reference');
    toggle.click();
    await new Promise(r => setTimeout(r, 400));

    const startProfiles = document.querySelectorAll('.ref-list li.draggable').length;
    const unassignedHead = document.querySelector('.ru-head')?.textContent ?? null;
    const unassignedCount = document.querySelectorAll('.ref-unassigned .ref-list li').length;

    // Create a profile covering three Ben variables.
    Array.from(document.querySelectorAll('.ref-actions button'))
      .find(b => b.textContent === 'Add character').click();
    await new Promise(r => setTimeout(r, 350));
    const dialogOpen = !!document.querySelector('.pick-list');

    const filter = Array.from(document.querySelectorAll('.modal input'))
      .find(i => i.placeholder === 'Filter variables');
    const setVal = (el, v) => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(el, v);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    };
    setVal(filter, 'ava');
    await new Promise(r => setTimeout(r, 250));
    const offered = Array.from(document.querySelectorAll('.pick-list .pl-var')).map(e => e.textContent);

    // Reported rather than thrown: an exception in here leaves the harness
    // waiting on a promise that never settles, so a missing variable would
    // cost eight minutes and tell nobody which one it was.
    const missing = [];
    for (const want of ['ava', 'ava_thoughts', 'ava_alter']) {
      const li = Array.from(document.querySelectorAll('.pick-list li'))
        .find(el => el.querySelector('.pl-var')?.textContent === want);
      if (!li) { missing.push(want); continue; }
      li.click();
      await new Promise(r => setTimeout(r, 120));
    }
    const picked = document.querySelectorAll('.pick-list li.on').length;
    const nameInput = document.querySelector('.modal .field input');
    const suggestedName = nameInput.value;

    Array.from(document.querySelectorAll('.modal button')).find(b => b.textContent.indexOf('Create') === 0).click();
    await new Promise(r => setTimeout(r, 600));

    const openedTab = !!document.querySelector('.chareditor');
    const varRows = Array.from(document.querySelectorAll('.ce-varlist li .cv-name')).map(e => e.textContent);
    const scriptNames = Array.from(document.querySelectorAll('.ce-varlist .cv-script')).map(e => e.textContent);
    const exprCount = document.querySelectorAll('.ce-vars .rd-chip').length;
    const afterProfiles = document.querySelectorAll('.ref-list li.draggable').length;
    const afterUnassigned = document.querySelectorAll('.ref-unassigned .ref-list li').length;

    await new Promise(r => setTimeout(r, 1700));
    const saved = await window.api.readReference(${JSON.stringify(root)});

    return { missing, startProfiles, unassignedHead, unassignedCount, dialogOpen, offered, picked,
             suggestedName, openedTab, varRows, scriptNames, exprCount,
             afterProfiles, afterUnassigned,
             savedVarNames: saved.characters[0]?.varNames ?? [],
             savedName: saved.characters[0]?.name ?? null,
             savedOrder: saved.characterOrder ?? [] };
  })()`)

  check('nothing is auto-imported as a profile', prof.startProfiles === 0, String(prof.startProfiles))
  check('every variable the picker was asked for exists',
    Array.isArray(prof.missing) && prof.missing.length === 0, JSON.stringify(prof.missing))
  check('script characters are listed as unassigned', prof.unassignedCount >= 10,
    String(prof.unassignedCount))
  check('the unassigned heading says so',
    typeof prof.unassignedHead === 'string' && prof.unassignedHead.indexOf('no profile yet') !== -1,
    String(prof.unassignedHead))
  check('the add dialog offers script variables', prof.dialogOpen === true)
  check('filtering narrows the variable list',
    prof.offered.every(v => v.indexOf('ava') === 0 || v.indexOf('Ava') === 0),
    JSON.stringify(prof.offered))
  check('several variables can be selected', prof.picked === 3, String(prof.picked))
  check('the name is suggested from the first pick', prof.suggestedName === 'Ava',
    String(prof.suggestedName))
  check('creating opens the profile full size', prof.openedTab === true)
  check('the profile lists all three variables',
    JSON.stringify(prof.varRows) === JSON.stringify(['ava', 'ava_thoughts', 'ava_alter']),
    JSON.stringify(prof.varRows))
  check('each variable keeps its own script name', prof.scriptNames.length === 3, JSON.stringify(prof.scriptNames))
  check('expressions are pooled across variables', prof.exprCount >= 7, String(prof.exprCount))
  check('one profile now exists', prof.afterProfiles === 1, String(prof.afterProfiles))
  check('the claimed variables left the unassigned list',
    prof.afterUnassigned === prof.unassignedCount - 3,
    prof.unassignedCount + ' -> ' + prof.afterUnassigned)
  check('the profile reached disk with all three variables',
    prof.savedVarNames.join(',') === 'ava,ava_thoughts,ava_alter',
    prof.savedVarNames.join(','))
  check('the order list records it', prof.savedOrder.length === 1, JSON.stringify(prof.savedOrder))

  // What the script calls somebody and who they are need not be the same. A
  // character the game only ever names as Detective Cook can be James Cook in
  // the notes, and the script is left saying what it says.
  const fullName = await js(`(async () => {${UNTIL}
    const field = Array.from(document.querySelectorAll('.chareditor .ref-field'))
      .find(el => el.querySelector('.rf-label')?.textContent === 'Full name');
    if (!field) {
      return { stage: 'no such field',
               fields: Array.from(document.querySelectorAll('.chareditor .rf-label'))
                 .map(e => e.textContent) };
    }
    field.querySelector('.rf-view').dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    const input = await until(() => field.querySelector('input'));
    if (!input) return { stage: 'field would not open' };
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      .call(input, 'Ava Vale-Whitmore');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    await wait(1800);

    const saved = await window.api.readReference(${JSON.stringify(root)});
    const scriptNames = Array.from(document.querySelectorAll('.chareditor .cv-script'))
      .map(e => e.textContent);
    return {
      stage: 'ok',
      shown: field.querySelector('.rf-view')?.textContent ?? null,
      scriptNames,
      savedFullName: saved.characters[0]?.fullName ?? null,
      savedName: saved.characters[0]?.name ?? null
    };
  })()`)

  check('a character has a full name of their own', fullName.stage === 'ok',
    JSON.stringify(fullName).slice(0, 200))
  check('it is kept with the notes', fullName.savedFullName === 'Ava Vale-Whitmore',
    String(fullName.savedFullName))
  check('and the name the script uses is left alone',
    (fullName.scriptNames ?? []).includes('Ava'), JSON.stringify(fullName.scriptNames))
  check('both are on screen at once, which is the point',
    (fullName.shown ?? '').includes('Vale-Whitmore') && (fullName.scriptNames ?? []).length > 0,
    String(fullName.shown))

  console.log('\n[assigning a variable to an existing profile]')
  const assigned = await js(`(async () => {
    const select = document.querySelector('.ce-assign select');
    const optionCount = select.options.length;
    // Reported, not thrown: see the picker above.
    const target = Array.from(select.options).find(o => o.value === 'cora');
    if (!target) return { optionCount, rows: [], afterUnlink: [], missing: 'cora' };
    Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set.call(select, target.value);
    select.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise(r => setTimeout(r, 500));
    const rows = Array.from(document.querySelectorAll('.ce-varlist li .cv-name')).map(e => e.textContent);

    // And unlink it again.
    const row = Array.from(document.querySelectorAll('.ce-varlist li'))
      .find(li => li.querySelector('.cv-name')?.textContent === 'cora');
    if (!row) return { optionCount, rows, afterUnlink: [], missing: 'cora row' };
    row.querySelector('.cv-remove').click();
    await new Promise(r => setTimeout(r, 400));
    const afterUnlink = Array.from(document.querySelectorAll('.ce-varlist li .cv-name')).map(e => e.textContent);
    return { optionCount, rows, afterUnlink };
  })()`)
  check('unassigned variables are offered for linking', assigned.optionCount >= 8,
    String(assigned.optionCount))
  check('linking adds the variable to the profile',
    assigned.rows.indexOf('cora') !== -1, JSON.stringify(assigned.rows))
  check('unlinking removes it again',
    assigned.afterUnlink.indexOf('cora') === -1, JSON.stringify(assigned.afterUnlink))

  console.log('\n[renaming one variable in the script]')
  const renamed = await js(`(async () => {
    const before = await window.api.readEpisode(${JSON.stringify(root)}, 'script.rpy');
    const row = Array.from(document.querySelectorAll('.ce-varlist li'))
      .find(li => li.querySelector('.cv-name')?.textContent === 'ava_thoughts');
    if (!row) return { missing: 'ava_thoughts row' };
    row.querySelector('.cv-script').click();
    await new Promise(r => setTimeout(r, 200));
    const input = row.querySelector('.cv-script-input');
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      .call(input, 'Ava (inner)');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    await new Promise(r => setTimeout(r, 1100));
    const after = await window.api.readEpisode(${JSON.stringify(root)}, 'script.rpy');
    const NL2 = String.fromCharCode(10);
    return {
      wrote: after.indexOf('define ava_thoughts = Character("Ava (inner)"') !== -1,
      untouchedSibling: after.indexOf("define ava = Character('Ava'") !== -1,
      changed: after.split(NL2).filter((l, i) => l !== before.split(NL2)[i]).length,
      profileName: document.querySelector('.ce-head h1')?.textContent ?? null
    };
  })()`)
  check('renaming rewrites only that variable define', renamed.wrote === true)
  check('the sibling variable keeps its own name', renamed.untouchedSibling === true)
  check('exactly one script line changed', renamed.changed === 1, String(renamed.changed))
  check('the profile name is independent of script names',
    renamed.profileName === 'Ava', String(renamed.profileName))

  // The variable itself, which is the harder half: it is on every line that
  // character speaks, so renaming it rewrites the whole project.
  const varRenamed = await js(`(async () => {${UNTIL}
    const row = Array.from(document.querySelectorAll('.ce-varlist li'))
      .find(li => li.querySelector('.cv-name')?.textContent === 'ava_thoughts');
    if (!row) return { stage: 'no such row' };
    row.querySelector('.cv-rename').click();
    const modal = await until(() => document.querySelector('.rename-modal'));
    if (!modal) return { stage: 'no dialog' };

    const fields = Array.from(modal.querySelectorAll('.field input'));
    if (fields.length < 2) return { stage: 'not two fields', fields: fields.length };
    const prefilled = fields.map(f => f.value);

    const set = (el, v) => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(el, v);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    };
    set(fields[0], 'ava_inner');
    set(fields[1], 'Ava (inner voice)');
    await wait(200);
    Array.from(modal.querySelectorAll('.actions-row button'))
      .find(b => b.textContent.indexOf('Rename') === 0).click();
    await until(() => !document.querySelector('.rename-modal'), 12000);
    await wait(1200);

    return {
      stage: 'ok', prefilled,
      rows: Array.from(document.querySelectorAll('.ce-varlist li .cv-name')).map(e => e.textContent),
      scriptNames: Array.from(document.querySelectorAll('.ce-varlist .cv-script')).map(e => e.textContent),
      saved: (await window.api.readReference(${JSON.stringify(root)})).characters[0]?.varNames ?? []
    };
  })()`)

  check('a variable can be renamed from the character view', varRenamed.stage === 'ok',
    JSON.stringify(varRenamed).slice(0, 220))
  check('the dialog opens on what is there now',
    JSON.stringify(varRenamed.prefilled) === '["ava_thoughts","Ava (inner)"]',
    JSON.stringify(varRenamed.prefilled))
  check('the variable list shows the new name',
    (varRenamed.rows ?? []).includes('ava_inner') &&
    !(varRenamed.rows ?? []).includes('ava_thoughts'), JSON.stringify(varRenamed.rows))
  check('and the display name changed with it',
    (varRenamed.scriptNames ?? []).includes('Ava (inner voice)'),
    JSON.stringify(varRenamed.scriptNames))
  // The profile points at the variable by name. If it did not come along, the
  // character would be orphaned from their own notes.
  check('the profile followed the rename',
    (varRenamed.saved ?? []).includes('ava_inner'), JSON.stringify(varRenamed.saved))

  const renamedSource = await fs.readFile(path.join(root, 'game', 'scripts', 'script.rpy'), 'utf8')
  const renamedChapter = await fs.readFile(path.join(root, 'game', 'scripts', 'chapter_2.rpy'), 'utf8')
  check('the define was rewritten',
    renamedSource.includes('define ava_inner = Character("Ava (inner voice)"'),
    (renamedSource.split(/\r?\n/).find((l) => l.includes('ava_inner')) ?? 'not found'))
  check('the lines they speak were rewritten too',
    /^\s+ava_inner\b/m.test(renamedChapter),
    (renamedChapter.split(/\r?\n/).find((l) => l.includes('ava_inner')) ?? 'not found'))
  check('the old name is gone from the script',
    !renamedSource.includes('ava_thoughts') && !renamedChapter.includes('ava_thoughts'),
    'ava_thoughts still there')
  check('while the sibling variable it starts like is untouched',
    /define ava = Character/.test(renamedSource) && /^\s+ava\b/m.test(renamedChapter),
    'ava went missing')

  console.log('\n[ctrl+click resolves through the profile]')
  const ctrlClicked = await js(`(async () => {
    Array.from(document.querySelectorAll('.tab')).find(t => t.textContent.indexOf('chapter_2') !== -1)?.click();
    await new Promise(r => setTimeout(r, 450));
    Array.from(document.querySelectorAll('.mode-switch button')).find(b => b.textContent === 'Writer')?.click();
    await new Promise(r => setTimeout(r, 800));
    const cue = Array.from(document.querySelectorAll('.blk-character-name'))
      .find(e => e.getAttribute('title')?.indexOf('ava') === 0);
    if (!cue) return { stage: 'no ava cue' };
    cue.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }));
    await new Promise(r => setTimeout(r, 700));
    return {
      openedProfile: document.querySelector('.ce-head h1')?.textContent ?? null,
      isTab: !!document.querySelector('.chareditor'),
      cueTitle: cue.getAttribute('title'),
      tabs: Array.from(document.querySelectorAll('.tab')).map((t) => t.textContent)
    };
  })()`)
  check('ctrl+click on a cue opens its profile, not the variable',
    ctrlClicked.openedProfile === 'Ava',
    `${ctrlClicked.stage ?? ''} got=${ctrlClicked.openedProfile} cue=${ctrlClicked.cueTitle} ` +
    `tabs=${JSON.stringify(ctrlClicked.tabs)}`)
  check('it opens as a full tab', ctrlClicked.isTab === true)

  console.log('\n[two character tabs stay put while editing]')
  const twoTabs = await js(`(async () => {
    const panelOpen = () => !!document.querySelector('.refpanel');
    if (!panelOpen()) {
      Array.from(document.querySelectorAll('button')).find(b => b.textContent === 'Reference').click();
      await new Promise(r => setTimeout(r, 400));
    }

    // A second profile, so two character tabs can be open at once.
    const addProfile = async (name, varName) => {
      Array.from(document.querySelectorAll('.ref-actions button'))
        .find(b => b.textContent === 'Add character').click();
      await new Promise(r => setTimeout(r, 350));
      const nameInput = document.querySelector('.modal .field input');
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
        .call(nameInput, name);
      nameInput.dispatchEvent(new Event('input', { bubbles: true }));
      const filter = Array.from(document.querySelectorAll('.modal input'))
        .find(i => i.placeholder === 'Filter variables');
      if (filter && varName) {
        Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
          .call(filter, varName);
        filter.dispatchEvent(new Event('input', { bubbles: true }));
        await new Promise(r => setTimeout(r, 250));
        const li = Array.from(document.querySelectorAll('.pick-list li'))
          .find(el => el.querySelector('.pl-var')?.textContent === varName);
        li?.click();
        await new Promise(r => setTimeout(r, 200));
      }
      Array.from(document.querySelectorAll('.modal button'))
        .find(b => b.textContent.indexOf('Create') === 0).click();
      await new Promise(r => setTimeout(r, 700));
    };

    await addProfile('Ben', 'ben');
    const leonTab = document.querySelector('.tab.active')?.textContent ?? null;

    // Ctrl+click a Ava cue in the writer, which is what set the sticky focus.
    Array.from(document.querySelectorAll('.tab')).find(t => t.textContent.indexOf('chapter_2') !== -1)?.click();
    await new Promise(r => setTimeout(r, 400));
    Array.from(document.querySelectorAll('.mode-switch button')).find(b => b.textContent === 'Writer')?.click();
    await new Promise(r => setTimeout(r, 800));
    const cue = Array.from(document.querySelectorAll('.blk-character-name'))
      .find(e => e.getAttribute('title')?.indexOf('ava') === 0);
    cue?.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }));
    await new Promise(r => setTimeout(r, 700));

    // Now open the other character's tab and edit a field there.
    const tabLabels = Array.from(document.querySelectorAll('.tab')).map(t => t.textContent);
    const aliceTab = Array.from(document.querySelectorAll('.tab'))
      .find(t => t.textContent.indexOf('Ben') !== -1);
    if (!aliceTab) return { stage: 'no ben tab', tabLabels, leonTab };
    aliceTab.click();
    await new Promise(r => setTimeout(r, 500));
    const beforeEdit = document.querySelector('.tab.active')?.textContent ?? null;
    const headingBefore = document.querySelector('.ce-head h1')?.textContent ?? null;

    const field = Array.from(document.querySelectorAll('.chareditor .ref-field'))
      .find(el => el.querySelector('.rf-label')?.textContent === 'Birthday');
    if (!field) return { stage: 'no birthday field' };
    field.querySelector('.rf-view').dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    await new Promise(r => setTimeout(r, 250));
    const opened = !!field.querySelector('input');
    const tabWhileEditing = document.querySelector('.tab.active')?.textContent ?? null;

    const input = field.querySelector('input');
    if (input) {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
        .call(input, 'December 6');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    }
    await new Promise(r => setTimeout(r, 900));

    return {
      stage: 'ok', leonTab, beforeEdit, headingBefore, opened, tabWhileEditing,
      tabAfterEdit: document.querySelector('.tab.active')?.textContent ?? null,
      headingAfter: document.querySelector('.ce-head h1')?.textContent ?? null,
      saved: field.querySelector('.rf-view')?.textContent ?? null
    };
  })()`)

  check('two character tabs can be open', twoTabs.stage === 'ok',
    twoTabs.stage + ' tabs=' + JSON.stringify(twoTabs.tabLabels) + ' leonTab=' + twoTabs.leonTab)
  check('clicking a field opens an editor', twoTabs.opened === true)
  check('the tab does not change when a field is clicked',
    twoTabs.tabWhileEditing === twoTabs.beforeEdit,
    twoTabs.beforeEdit + ' -> ' + twoTabs.tabWhileEditing)
  check('the tab does not change when the edit is committed',
    twoTabs.tabAfterEdit === twoTabs.beforeEdit,
    twoTabs.beforeEdit + ' -> ' + twoTabs.tabAfterEdit)
  check('the editor still shows the same character',
    twoTabs.headingAfter === twoTabs.headingBefore,
    twoTabs.headingBefore + ' -> ' + twoTabs.headingAfter)
  check('the edited value stuck', twoTabs.saved === 'December 6', String(twoTabs.saved))

  console.log('\n[a real press opens a field and keeps it open]')
  // Driven with sendInputEvent, not dispatchEvent. The regression this covers
  // was invisible to synthetic events: mousedown opened the field, then the
  // press's own default action moved focus off the fresh input, blurring it
  // shut again, so nothing appeared to happen at all.
  const fieldPoint = (label) =>
    js(
      '(() => {' +
      '  const f = Array.from(document.querySelectorAll(".chareditor .ref-field"))' +
      '    .find(el => el.querySelector(".rf-label")?.textContent === ' + JSON.stringify(label) + ');' +
      '  const v = f && f.querySelector(".rf-view");' +
      '  if (!v) return null;' +
      '  const b = v.getBoundingClientRect();' +
      '  return { x: Math.round(b.left + 8), y: Math.round(b.top + b.height / 2) };' +
      '})()'
    )

  const editorState = () =>
    js(`(() => ({
      heading: document.querySelector('.ce-head h1')?.textContent ?? null,
      open: document.querySelectorAll('.chareditor .ref-field input, .chareditor .ref-field textarea').length,
      focusedInField: !!document.activeElement?.closest?.('.chareditor .ref-field')
    }))()`)

  // Typing through sendInputEvent only reaches the page while the window holds
  // OS focus, and focus does not survive the reloads earlier in this run. Claim
  // it back, and assert it, so a focus loss fails here with a reason rather
  // than downstream as an edit that silently did nothing.
  // Windows will not always hand the foreground to a process that is not
  // already in it, so ask more than once and in more than one way rather than
  // assuming a single call worked.
  let focused = false
  for (let attempt = 0; attempt < 5 && !focused; attempt++) {
    win.showInactive()
    win.moveTop()
    win.focus()
    win.focusOnWebView()
    win.webContents.focus()
    await sleep(400)
    focused = await js(`document.hasFocus()`)
  }
  check('the window has keyboard focus for the typing checks', focused === true,
    'the desktop would not give this window the foreground, so keystrokes go nowhere')

  const pressed = await (async () => {
    const onCharacterTab = await js(`(async () => {
      const t = Array.from(document.querySelectorAll('.tab')).find(x => x.textContent.indexOf('Ben') !== -1);
      if (!t) return false;
      t.click();
      await new Promise(r => setTimeout(r, 500));
      return !!document.querySelector('.chareditor');
    })()`)
    if (!onCharacterTab) return { stage: 'no character tab' }

    const at = await fieldPoint('Age')
    if (!at) return { stage: 'no Age field' }
    await realClick(at.x, at.y)
    const afterPress = await editorState()

    // The failure mode was open-then-shut within a frame; look again later.
    await sleep(500)
    const stillOpen = await editorState()

    await typeText('31')
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' })
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' })
    // Reference material saves on the same 1200ms debounce as scripts.
    await sleep(2000)

    const committed = await js(`(() => {
      const f = Array.from(document.querySelectorAll('.chareditor .ref-field'))
        .find(el => el.querySelector('.rf-label')?.textContent === 'Age');
      return f?.querySelector('.rf-view')?.textContent ?? null;
    })()`)
    const stored = await js(`window.api.readReference(${JSON.stringify(root)})`)

    // A second field takes over cleanly rather than stacking up.
    const second = await fieldPoint('Birthday')
    if (second) await realClick(second.x, second.y)
    const afterSecond = await editorState()

    return { stage: 'ok', afterPress, stillOpen, committed, stored, afterSecond }
  })()

  check('a real press opens the field', pressed.afterPress?.open === 1,
    pressed.stage + ' ' + JSON.stringify(pressed.afterPress))
  check('the press leaves focus in the field', pressed.afterPress?.focusedInField === true,
    JSON.stringify(pressed.afterPress))
  check('the field is still open a moment later', pressed.stillOpen?.open === 1,
    JSON.stringify(pressed.stillOpen))
  check('typed text commits to the view', pressed.committed === '31', String(pressed.committed))
  check('and reaches the sidecar file',
    (pressed.stored?.characters ?? []).some(c => c.name === 'Ben' && c.age === '31'),
    JSON.stringify((pressed.stored?.characters ?? []).map(c => c.name + ':' + (c.age ?? ''))))
  check('pressing a second field hands the editor over',
    pressed.afterSecond?.open === 1, JSON.stringify(pressed.afterSecond))
  check('editing never leaves the character', pressed.afterSecond?.heading === 'Ben',
    String(pressed.afterSecond?.heading))

  // Hand the keyboard back. That section is the only one that needs the
  // foreground -- real key events go to whichever window the desktop says is
  // in front -- and a suite that keeps it for the remaining several minutes is
  // one nobody can run while doing anything else.
  win.blur()

  console.log('\n[image hover in the code view]')
  const hover = await js(`(async () => {
    Array.from(document.querySelectorAll('.tab')).find(t => t.textContent.indexOf('chapter_2') !== -1)?.click();
    await new Promise(r => setTimeout(r, 400));
    Array.from(document.querySelectorAll('.mode-switch button')).find(b => b.textContent === 'Code')?.click();
    await new Promise(r => setTimeout(r, 1200));

    // Whatever scene line happens to be rendered; CodeMirror only mounts the
    // visible range, so a fixed line number is not reliable.
    const RE = /^[ ]*scene ([a-z0-9_]+)[ ]*$/;
    const target = Array.from(document.querySelectorAll('.cm-line')).find(l => RE.test(l.textContent));
    if (!target) return { stage: 'no scene line visible' };
    const name = target.textContent.match(RE)[1];
    const expected = await window.api.resolveImage(${JSON.stringify(root)}, name);

    const idx = target.textContent.indexOf(name) + 2;
    const walker = document.createTreeWalker(target, NodeFilter.SHOW_TEXT);
    let seen = 0, node = null, offset = 0;
    while (walker.nextNode()) {
      const len = walker.currentNode.textContent.length;
      if (seen + len > idx) { node = walker.currentNode; offset = idx - seen; break; }
      seen += len;
    }
    if (!node) return { stage: 'could not locate the name', name };
    const range = document.createRange();
    range.setStart(node, offset);
    range.setEnd(node, offset + 1);
    const box = range.getBoundingClientRect();

    const fire = (type) => target.dispatchEvent(new MouseEvent(type, {
      bubbles: true, clientX: box.left + box.width / 2, clientY: box.top + box.height / 2
    }));
    fire('mousemove');
    await new Promise(r => setTimeout(r, 350));
    fire('mousemove');

    let tip = null;
    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 150));
      tip = document.querySelector('.img-tip');
      if (tip) break;
    }
    if (!tip) return { stage: 'no tooltip', name, expected };
    const img = tip.querySelector('img');
    return {
      stage: 'ok', name,
      expectedImage: !!expected.dataUrl,
      hasImage: !!img,
      decoded: img ? (img.complete && img.naturalWidth > 0) : false,
      missingNote: !!tip.querySelector('.img-tip-note.missing'),
      caption: tip.querySelector('.img-tip-caption')?.textContent ?? null
    };
  })()`)
  check('hovering a scene name shows a tooltip', hover.stage === 'ok',
    hover.stage + ' ' + (hover.name ?? ''))
  check('the tooltip matches what the name resolves to',
    hover.expectedImage ? hover.hasImage === true : hover.missingNote === true,
    'expected image: ' + hover.expectedImage + ', got image: ' + hover.hasImage)
  check('a previewed image decodes',
    hover.expectedImage ? hover.decoded === true : true)
  check('the tooltip names the image', hover.caption === hover.name,
    hover.caption + ' vs ' + hover.name)

  console.log('\n[large chapter: 5292 lines]')
  await js(`(async () => { await window.api.createEpisode({
    renpyRoot: ${JSON.stringify(root)}, mode: 'import', name: 'Chapter 1', fileName: 'chapter_1.rpy' }); })()`)
  await win.webContents.reload()
  await sleep(1200)
  await js(`document.querySelector('.project-item')?.click()`)
  await sleep(1500)
  const bigStart = Date.now()
  await js(`Array.from(document.querySelectorAll('.episode-row')).find(e => e.textContent.includes('chapter_1'))?.click()`)
  await sleep(250)
  await js(`Array.from(document.querySelectorAll('.mode-switch button')).find(b => b.textContent === 'Writer')?.click()`)
  let big = { blocks: 0, dialogue: 0, labels: 0 }
  for (let i = 0; i < 40; i++) {
    big = await js(`(() => ({ blocks: document.querySelectorAll('.writer-page > *').length, dialogue: document.querySelectorAll('.blk-dialogue').length, labels: document.querySelectorAll('.blk-label').length }))()`)
    if (big.blocks > 0) break
    await sleep(250)
  }
  const bigMs = Date.now() - bigStart
  check('large chapter renders its blocks', big.blocks > 1500, String(big.blocks))
  check('large chapter labels rendered', big.labels === 35, String(big.labels))
  check('large chapter dialogue rendered', big.dialogue > 1000, String(big.dialogue))
  check('large chapter opens in under 6s (' + bigMs + 'ms)', bigMs < 6000, bigMs + 'ms')

  const typing = await js(`(async () => {
    const t0 = performance.now();
    document.querySelector('.blk-text .blk-view')?.click();
    await new Promise(r => setTimeout(r, 80));
    return { openedEditor: !!document.querySelector('.blk-input'), ms: performance.now() - t0 };
  })()`)
  check('clicking a line opens an editor on a large file', typing.openedEditor)
  check('editor opens fast (' + Math.round(typing.ms) + 'ms)', typing.ms < 1000, Math.round(typing.ms) + 'ms')

  console.log('\n[translate and proofread entry points]')
  const entry = await js(`(async () => {
    const rightClick = (el) => el.dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true, clientX: 200, clientY: 200
    }));
    const menuLabels = () => Array.from(document.querySelectorAll('.ctx-item')).map(b => b.textContent);
    const closeMenu = () => document.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));

    const noTopButton = !Array.from(document.querySelectorAll('.tabbar button'))
      .some(b => b.textContent === 'Translate');

    // Right-click an episode.
    rightClick(document.querySelector('.episode-row'));
    await new Promise(r => setTimeout(r, 250));
    const episodeMenu = menuLabels();
    const menuPlaced = !!document.querySelector('.ctxmenu');
    closeMenu();
    await new Promise(r => setTimeout(r, 200));
    const closedAfterOutsideClick = !document.querySelector('.ctxmenu');

    // Right-click a beat.
    rightClick(document.querySelector('.beat-row'));
    await new Promise(r => setTimeout(r, 250));
    const beatMenu = menuLabels();

    // Escape closes it too.
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await new Promise(r => setTimeout(r, 200));
    const closedByEscape = !document.querySelector('.ctxmenu');

    const caps = await window.api.capabilities();
    return { caps, noTopButton, episodeMenu, menuPlaced, closedAfterOutsideClick, beatMenu, closedByEscape };
  })()`)
  check('Translate is gone from the tab bar', entry.noTopButton === true)
  check('right-clicking an episode opens a menu', entry.menuPlaced === true)
  check('the desktop declares it can do everything',
    entry.caps && entry.caps.renderSync && entry.caps.imagePreviews &&
    entry.caps.folderPicker && entry.caps.languagePasses,
    JSON.stringify(entry.caps))
  check('the episode menu offers a translation',
    entry.episodeMenu.some(l => l.startsWith('Translate')), JSON.stringify(entry.episodeMenu))
  check('the episode menu offers a proofread',
    entry.episodeMenu.some(l => l.startsWith('Proofread')), JSON.stringify(entry.episodeMenu))
  check('the episode menu offers the draft toggle',
    entry.episodeMenu.some(l => l.includes('draft') || l.includes('game')),
    JSON.stringify(entry.episodeMenu))
  check('right-clicking a beat offers both passes at both scopes',
    entry.beatMenu.length === 4 &&
    entry.beatMenu.filter(l => l.startsWith('Translate')).length === 2 &&
    entry.beatMenu.filter(l => l.startsWith('Proofread')).length === 2,
    JSON.stringify(entry.beatMenu))
  check('clicking away closes the menu', entry.closedAfterOutsideClick === true)
  check('Escape closes the menu', entry.closedByEscape === true)

  const fromMenu = await js(`(async () => {
    document.querySelector('.beat-row').dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true, clientX: 200, clientY: 200
    }));
    await new Promise(r => setTimeout(r, 250));
    const item = document.querySelector('.ctx-item');
    item.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    const survivedPress = !!document.querySelector('.ctxmenu');
    // A real mouse sends mousedown before click. Clicking alone hid a bug where
    // the menu dismissed itself on mousedown and the item never fired.
    item.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    item.click();
    await new Promise(r => setTimeout(r, 700));
    const modal = document.querySelector('.pass-modal');
    const scopes = Array.from(document.querySelectorAll('.seg-choice button')).map(b => ({
      text: b.querySelector('.t')?.textContent,
      detail: b.querySelector('.d')?.textContent,
      on: b.classList.contains('on')
    }));
    document.querySelector('.modal-backdrop').click();
    await new Promise(r => setTimeout(r, 250));
    return { survivedPress, opened: !!modal, scopes, closed: !document.querySelector('.pass-modal') };
  })()`)
  check('the menu survives the press that selects an item', fromMenu.survivedPress === true)
  check('choosing translate opens the panel', fromMenu.opened === true)
  check('it opens scoped to that beat',
    fromMenu.scopes.find(s => s.text === 'This beat')?.on === true, JSON.stringify(fromMenu.scopes))
  check('the beat scope names the label and its lines',
    /lines \d+/.test(fromMenu.scopes.find(s => s.text === 'This beat')?.detail ?? ''),
    JSON.stringify(fromMenu.scopes))
  check('the panel closes again', fromMenu.closed === true)

  const inWriter = await js(`(async () => {
    Array.from(document.querySelectorAll('.mode-switch button')).find(b => b.textContent === 'Writer')?.click();
    await new Promise(r => setTimeout(r, 800));
    const label = document.querySelector('.blk-label');
    const group = label?.querySelector('.blk-label-actions');
    const actions = Array.from(group?.querySelectorAll('.blk-label-action') ?? []);
    if (actions.length === 0) return { stage: 'no action buttons' };

    // getComputedStyle resolves an auto margin to its used value, so compare
    // the actual geometry instead.
    const restingOpacity = Number(getComputedStyle(actions[0]).opacity);
    const rowBox = label.getBoundingClientRect();
    const groupBox = group.getBoundingClientRect();
    const gapFromRight = rowBox.right - groupBox.right;
    const nameBox = label.querySelector('.blk-label-name')?.getBoundingClientRect();
    const isAfterName = nameBox ? groupBox.left >= nameBox.right - 1 : false;

    const open = async (text) => {
      actions.find(a => a.textContent === text).click();
      await new Promise(r => setTimeout(r, 600));
      const heading = document.querySelector('.pass-modal h2')?.textContent ?? null;
      const scopes = Array.from(document.querySelectorAll('.seg-choice button')).map(b => ({
        text: b.querySelector('.t')?.textContent, on: b.classList.contains('on')
      }));
      const primary = Array.from(document.querySelectorAll('.pass-modal .actions-row button'))
        .find(b => b.classList.contains('primary'))?.textContent ?? null;
      const hint = document.querySelector('.pass-modal .hint')?.textContent ?? '';
      document.querySelector('.modal-backdrop')?.click();
      await new Promise(r => setTimeout(r, 300));
      return { heading, scopes, primary, hint };
    };

    return {
      stage: 'ok',
      labels: actions.map(a => a.textContent),
      titles: actions.map(a => a.getAttribute('title') ?? ''),
      gapFromRight, isAfterName, restingOpacity,
      translate: await open('Translate'),
      proofread: await open('Proofread')
    };
  })()`)
  check('every label carries its pass actions', inWriter.stage === 'ok', String(inWriter.stage))
  check('they read Translate and Proofread, with the scene menu after them',
    JSON.stringify((inWriter.labels ?? []).slice(0, 2)) === '["Translate","Proofread"]' &&
    (inWriter.labels ?? []).length === 3, JSON.stringify(inWriter.labels))
  check('they sit at the right end of the label row',
    Math.abs(inWriter.gapFromRight) <= 2 && inWriter.isAfterName === true,
    'gap from right: ' + inWriter.gapFromRight + ', after the name: ' + inWriter.isAfterName)
  check('they are visible without hovering', inWriter.restingOpacity > 0.3,
    String(inWriter.restingOpacity))
  check('each pass action names the line range it would cover',
    (inWriter.titles ?? []).slice(0, 2).every(t => /lines \d+/.test(t)),
    JSON.stringify(inWriter.titles))
  check('translate opens the panel scoped to that beat',
    inWriter.translate.scopes.find(s => s.text === 'This beat')?.on === true,
    JSON.stringify(inWriter.translate.scopes))
  check('proofread opens the panel scoped to that beat',
    inWriter.proofread.scopes.find(s => s.text === 'This beat')?.on === true,
    JSON.stringify(inWriter.proofread.scopes))
  check('the two panels are told apart by their heading',
    (inWriter.translate.heading ?? '').includes('Translate') &&
    (inWriter.proofread.heading ?? '').includes('Proofread') &&
    !(inWriter.proofread.heading ?? '').includes('→'),
    inWriter.translate.heading + ' / ' + inWriter.proofread.heading)
  check('each panel confirms its own action',
    inWriter.translate.primary === 'Translate' && inWriter.proofread.primary === 'Proofread',
    inWriter.translate.primary + ' / ' + inWriter.proofread.primary)
  check('proofreading says untranslated lines are left alone',
    inWriter.proofread.hint.includes('left for the translation pass'), inWriter.proofread.hint)
  check('proofreading says the character voice is protected',
    inWriter.proofread.hint.includes('not tidied away'), inWriter.proofread.hint)

  console.log('\n[running a pass end to end]')
  // A stub standing in for the CLI, so the whole path is exercised for real:
  // settings -> IPC -> prompt -> file on disk -> revert. It answers under the
  // key the prompt asked for, which is also how the two modes are told apart.
  const stubJs = path.join(root, 'stub.js')
  const stubCmd = path.join(root, 'stub.cmd')
  await fs.writeFile(
    stubJs,
    [
      "let input = ''",
      "process.stdin.on('data', (d) => (input += d))",
      "process.stdin.on('end', () => {",
      "  const proofing = input.includes('Proofread visual novel dialogue')",
      "  const ids = [...input.matchAll(/\"id\":(\\d+)/g)].map((m) => Number(m[1]))",
      "  const tag = proofing ? 'PROOFED' : 'TRANSLATED'",
      "  const items = ids.map((id) => ({ id, text: tag + ' ' + id }))",
      "  process.stdout.write(JSON.stringify(proofing ? { revisions: items } : { translations: items }))",
      "})"
    ].join('\n'),
    'utf8'
  )
  await fs.writeFile(stubCmd, '@echo off\r\nnode "' + stubJs + '"\r\n', 'utf8')

  const ran = await js(`(async () => {
    const root = ${JSON.stringify(root)};
    const before = await window.api.readEpisode(root, 'chapter_2.rpy');

    const project = await window.api.openProject(root);
    const settings = { ...project.project.settings, translateCommand: ${JSON.stringify(stubCmd)} };
    await window.api.updateSettings(root, settings);

    const proofread = await window.api.runScriptPass(root, {
      fileName: 'chapter_2.rpy', mode: 'proofread'
    });
    const afterProof = await window.api.readEpisode(root, 'chapter_2.rpy');

    // Put it back, exactly as the panel's revert does.
    await window.api.writeEpisode(root, 'chapter_2.rpy', proofread.previous);
    const restored = await window.api.readEpisode(root, 'chapter_2.rpy');

    const translated = await window.api.runScriptPass(root, {
      fileName: 'chapter_2.rpy', mode: 'translate'
    });
    await window.api.writeEpisode(root, 'chapter_2.rpy', translated.previous);
    const restoredAgain = await window.api.readEpisode(root, 'chapter_2.rpy');

    return {
      before,
      proofread: {
        changes: proofread.changes.length,
        skipped: proofread.skipped,
        error: proofread.error ?? null,
        sample: proofread.changes[0] ?? null,
        allTagged: proofread.changes.every(c => c.after.startsWith('PROOFED ')),
        lines: proofread.changes.map(c => c.line)
      },
      translated: {
        changes: translated.changes.length,
        skipped: translated.skipped,
        error: translated.error ?? null,
        allTagged: translated.changes.every(c => c.after.startsWith('TRANSLATED ')),
        lines: translated.changes.map(c => c.line)
      },
      wroteToDisk: afterProof.includes('PROOFED '),
      restoredExactly: restored === before,
      restoredAgainExactly: restoredAgain === before
    };
  })()`)

  check('a proofreading pass runs without error', ran.proofread.error === null,
    String(ran.proofread.error))
  check('it corrected the English lines', ran.proofread.changes > 0, String(ran.proofread.changes))
  check('it skipped the lines still in Czech', ran.proofread.skipped > 0,
    String(ran.proofread.skipped))
  check('the proofreader was asked, not the translator', ran.proofread.allTagged === true,
    JSON.stringify(ran.proofread.sample))
  check('the corrections reached the file on disk', ran.wroteToDisk === true)
  check('putting it back restores the file byte for byte', ran.restoredExactly === true)

  check('a translation pass runs the same way', ran.translated.error === null,
    String(ran.translated.error))
  check('the mode reaches the prompt', ran.translated.allTagged === true,
    String(ran.translated.changes))
  // Not disjoint, and deliberately so. A line is classified source, target or
  // unknown; each pass skips only what is confidently the other's, so the
  // ambiguous middle — short lines, names, interjections — goes to both, with
  // each prompt told to hand it back untouched if it is not its language.
  const shared = ran.proofread.lines.filter(l => ran.translated.lines.includes(l))
  const proofOnly = ran.proofread.lines.filter(l => !ran.translated.lines.includes(l))
  const transOnly = ran.translated.lines.filter(l => !ran.proofread.lines.includes(l))
  check('each pass has lines the other will not touch',
    proofOnly.length > 0 && transOnly.length > 0,
    'proofread only ' + proofOnly.length + ', translate only ' + transOnly.length)
  check('the overlap is only the lines neither can place',
    shared.length < ran.proofread.lines.length && shared.length < ran.translated.lines.length,
    'shared ' + shared.length + ' of ' + ran.proofread.lines.length + '/' + ran.translated.lines.length)
  check('what a pass skips is what the other pass owns outright',
    ran.proofread.skipped === transOnly.length &&
    ran.translated.skipped === proofOnly.length,
    'proofread skipped ' + ran.proofread.skipped + ' vs ' + transOnly.length +
    '; translated skipped ' + ran.translated.skipped + ' vs ' + proofOnly.length)
  check('the file is back to where it started', ran.restoredAgainExactly === true)

  // Leave the project on a command that is not there, so nothing can reach out
  // to a real CLI later in the run.
  await js(`(async () => {
    const p = await window.api.openProject(${JSON.stringify(root)});
    await window.api.updateSettings(${JSON.stringify(root)}, { ...p.project.settings, translateCommand: '' });
  })()`)

  console.log('\n[syncing renders]')
  // A real render folder with real renders in it, converted by a real encoder.
  const renderSrc = path.join(root, 'blender', 'Chapter 9 Part 2', 'Renders')
  await fs.mkdir(path.join(renderSrc, 'old'), { recursive: true })
  const realRenders = path.join(FIXTURE, 'renders')
  let copied = []
  try {
    copied = (await fs.readdir(realRenders)).filter((n) => n.endsWith('.png')).slice(0, 2)
    for (const n of copied) {
      await fs.copyFile(path.join(realRenders, n), path.join(renderSrc, n))
    }
  } catch {
    // Left empty; the checks below report it rather than passing vacuously.
  }
  // Things the scan must ignore, sitting where they really sit.
  await fs.writeFile(path.join(renderSrc, 'notes.txt'), 'not a render')
  await fs.copyFile(
    path.join(renderSrc, copied[0]),
    path.join(renderSrc, 'old', 'superseded.png')
  )

  // Prefer ffmpeg on PATH; fall back to a copy that ships with other software.
  const ffmpegCandidates = [
    'ffmpeg',
    'C:\\Program Files (x86)\\RenderIQ\\tools\\ffmpeg\\windows\\ffmpeg.exe'
  ]
  const which = async (cmd) =>
    new Promise((resolve) => {
      const child = spawn(cmd, ['-version'], { stdio: 'ignore' })
      child.on('error', () => resolve(false))
      child.on('close', (code) => resolve(code === 0))
    })
  let ffmpeg = null
  for (const c of ffmpegCandidates) {
    if (await which(c)) {
      ffmpeg = c
      break
    }
  }

  // Configure through the panel, not behind it: the menu label and the plan
  // both come from the project the UI is holding, so driving the IPC directly
  // would leave the interface describing a project state that never existed.
  const settingsSet = await js(`(async () => {
    const root = ${JSON.stringify(root)};
    const opened = await window.api.openProject(root);
    await window.api.updateSettings(root, {
      ...opened.project.settings,
      ffmpegPath: ${JSON.stringify(ffmpeg ?? '')},
      renderQuality: 100
    });
    const unset = await window.api.planRenderSync(root, opened.episodes[0].id);
    return { episodeId: opened.episodes[0].id, unsetError: unset.error ?? null };
  })()`)
  check('an episode with no render folder says so',
    (settingsSet.unsetError ?? '').includes('No render folder'), String(settingsSet.unsetError))

  const panel = await js(`(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms * ${PACE}));
    const openMenu = async () => {
      document.querySelector('.episode-row').dispatchEvent(new MouseEvent('contextmenu', {
        bubbles: true, clientX: 200, clientY: 200
      }));
      await wait(250);
      return Array.from(document.querySelectorAll('.ctx-item'));
    };
    const setInput = (el, value) => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
        .call(el, value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    };

    const before = (await openMenu()).map(b => b.textContent);
    const entry = (await openMenu()).find(b => b.textContent.indexOf('renders') !== -1);
    if (!entry) return { stage: 'no render entry', before };
    entry.click();
    await wait(500);
    if (!document.querySelector('.renders-modal')) return { stage: 'no panel', before };

    setInput(document.querySelector('#rs-source'), ${JSON.stringify(renderSrc)});
    setInput(document.querySelector('#rs-target'), 'ch9');
    await wait(200);
    Array.from(document.querySelectorAll('.renders-modal button'))
      .find(b => b.textContent === 'Save and scan').click();
    await wait(1500);

    const counts = Array.from(document.querySelectorAll('.rs-count')).map(e => e.textContent);
    const rows = Array.from(document.querySelectorAll('.rs-list li')).map(li => ({
      badge: li.querySelector('.rs-badge')?.textContent,
      name: li.querySelector('.rs-name')?.textContent,
      out: li.querySelector('.rs-out')?.textContent
    }));
    const convertLabel = Array.from(document.querySelectorAll('.renders-modal .actions-row button'))
      .find(b => b.classList.contains('primary'))?.textContent ?? null;

    Array.from(document.querySelectorAll('.renders-modal button'))
      .find(b => b.textContent === 'Close').click();
    await wait(400);

    const after = (await openMenu()).map(b => b.textContent);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await wait(200);
    return { stage: 'ok', before, after, counts, rows, convertLabel };
  })()`)

  check('the panel opens from the episode menu', panel.stage === 'ok',
    panel.stage + ' ' + JSON.stringify(panel.before))
  check('an unconfigured episode offers setup',
    (panel.before ?? []).some(l => l.startsWith('Set up renders')), JSON.stringify(panel.before))
  check('the panel lists both renders as new',
    (panel.rows ?? []).length === 2 && panel.rows.every(r => r.badge === 'new'),
    JSON.stringify(panel.rows))
  check('it shows the .webp each will become',
    (panel.rows ?? []).every(r => r.out === r.name.replace('.png', '.webp')),
    JSON.stringify(panel.rows?.map(r => r.out)))
  check('it counts what it found',
    (panel.counts ?? []).some(c => c === '2 new') &&
    (panel.counts ?? []).some(c => c.includes('folder')),
    JSON.stringify(panel.counts))
  check('the button says how much work it will do',
    panel.convertLabel === 'Convert 2 images', String(panel.convertLabel))
  check('once configured the menu offers the sync itself',
    (panel.after ?? []).some(l => l.startsWith('Sync renders')), JSON.stringify(panel.after))

  const renders = await js(`(async () => {
    const root = ${JSON.stringify(root)};
    const opened = await window.api.openProject(root);
    const plan = await window.api.planRenderSync(root, opened.episodes[0].id);
    return {
      episodeId: opened.episodes[0].id,
      stored: opened.episodes[0].renders ?? null,
      targetDir: plan.targetDir,
      items: plan.items.map(i => ({ name: i.name, out: i.outputName, status: i.status, bytes: i.sourceBytes })),
      ignoredDirs: plan.ignoredDirs,
      ignoredFiles: plan.ignoredFiles
    };
  })()`)

  check('two real renders were staged', copied.length === 2, JSON.stringify(copied))
  check('the render folder is stored on the episode',
    renders.stored?.targetSubdir === 'ch9', JSON.stringify(renders.stored))
  check('it targets game/images/ch9',
    renders.targetDir === path.join(root, 'game', 'images', 'ch9'), String(renders.targetDir))
  check('the sub-folder is skipped', renders.ignoredDirs.join(',') === 'old',
    JSON.stringify(renders.ignoredDirs))
  check('the text file is skipped', renders.ignoredFiles === 1, String(renders.ignoredFiles))

  // What happens when the encoder is missing, which is what a fresh machine
  // looks like. The answer has to arrive before any converting starts.
  const noEncoder = await js(`(async () => {
    const root = ${JSON.stringify(root)};
    const opened = await window.api.openProject(root);
    await window.api.updateSettings(root, {
      ...opened.project.settings,
      renderEncoder: 'ffmpeg',
      ffmpegPath: 'definitely-not-ffmpeg-xyz'
    });
    const status = await window.api.checkFfmpeg(root);
    return status;
  })()`)
  check('a missing encoder is reported before converting', noEncoder.ok === false,
    JSON.stringify(noEncoder))
  check('the message names the command that failed',
    (noEncoder.error ?? '').includes('definitely-not-ffmpeg-xyz'), String(noEncoder.error))

  const blocked = await js(`(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms * ${PACE}));
    document.querySelector('.episode-row').dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true, clientX: 200, clientY: 200
    }));
    await wait(250);
    Array.from(document.querySelectorAll('.ctx-item'))
      .find(b => b.textContent.indexOf('renders') !== -1).click();
    await wait(1500);

    const banner = document.querySelector('.rs-encoder .error')?.textContent ?? null;
    const convert = Array.from(document.querySelectorAll('.renders-modal .actions-row button'))
      .find(b => b.classList.contains('primary'));
    const candidates = Array.from(document.querySelectorAll('.rs-candidates li')).map(li => ({
      label: li.querySelector('.rs-cand-label')?.textContent,
      command: li.querySelector('.rs-name')?.textContent
    }));
    const advice = document.querySelector('.rs-encoder .rf-hint')?.textContent ?? '';
    const shown = { banner, disabled: convert?.disabled ?? null, label: convert?.textContent ?? null, candidates, advice };

    Array.from(document.querySelectorAll('.renders-modal button'))
      .find(b => b.textContent === 'Close').click();
    await wait(300);
    return shown;
  })()`)
  check('the panel says so as soon as it opens', (blocked.banner ?? '').length > 0,
    String(blocked.banner))
  check('converting is refused rather than attempted', blocked.disabled === true,
    String(blocked.disabled) + ' ' + String(blocked.label))
  check('it either offers a working encoder or says how to install one',
    blocked.candidates.length > 0
      ? blocked.candidates.every(c => c.command && c.label)
      : blocked.advice.includes('winget install'),
    JSON.stringify(blocked.candidates) + ' | ' + blocked.advice.slice(0, 80))
  check('and warns that a running app keeps its old PATH',
    blocked.candidates.length > 0 || blocked.advice.includes('restart'),
    blocked.advice.slice(0, 120))

  await js(`(async () => {
    const root = ${JSON.stringify(root)};
    const opened = await window.api.openProject(root);
    await window.api.updateSettings(root, {
      ...opened.project.settings, ffmpegPath: ${JSON.stringify(ffmpeg ?? '')}
    });
  })()`)

  // The built-in encoder needs nothing installed, so this runs everywhere.
  await js(`(async () => {
    const root = ${JSON.stringify(root)};
    const opened = await window.api.openProject(root);
    await window.api.updateSettings(root, {
      ...opened.project.settings, renderEncoder: 'builtin', renderQuality: 100
    });
  })()`)

  const builtInStatus = await js(`window.api.checkFfmpeg(${JSON.stringify(root)})`)
  check('the built-in encoder is always available', builtInStatus.ok === true,
    JSON.stringify(builtInStatus))
  check('it names itself rather than an ffmpeg build',
    (builtInStatus.version ?? '').includes('Built in'), String(builtInStatus.version))

  const names = renders.items.map((i) => i.name)
  const run = await js(`(async () => {
    const root = ${JSON.stringify(root)};
    const id = ${JSON.stringify(renders.episodeId)};
    const started = Date.now();
    const results = await window.api.convertRenders(root, id, ${JSON.stringify(names)});
    const ms = Date.now() - started;
    const after = await window.api.planRenderSync(root, id);
    return {
      results, ms,
      statuses: after.items.map(i => ({ name: i.name, status: i.status, targetBytes: i.targetBytes }))
    };
  })()`)

  check('every render converted without any encoder installed',
    run.results.every(r => r.ok), JSON.stringify(run.results.map(r => r.error).filter(Boolean)))
  check('the webp files are on disk',
    run.statuses.every(s => (s.targetBytes ?? 0) > 0), JSON.stringify(run.statuses))
  check('webp is much smaller than the png',
    run.results.every((r, i) => r.bytes < renders.items[i].bytes / 2),
    JSON.stringify(run.results.map((r, i) => r.bytes + '/' + renders.items[i].bytes)))
  check('conversion is quick enough for a chapter',
    run.ms / names.length < 3000, Math.round(run.ms / names.length) + 'ms per image')
  check('a second scan finds nothing to do',
    run.statuses.every(s => s.status === 'current'), JSON.stringify(run.statuses))

  // The output must be a real WebP that decodes to the source dimensions, not
  // merely a file with the right extension.
  const decoded = await js(`(async () => {
    const target = ${JSON.stringify(path.join(root, 'game', 'images', 'ch9').replace('\\', '/'))};
    const url = 'file:///' + (target + '/' + ${JSON.stringify(names[0].replace('.png', '.webp'))}).replace(/\\\\/g, '/');
    const res = await fetch(url);
    const blob = await res.blob();
    const head = new Uint8Array(await blob.slice(0, 16).arrayBuffer());
    const tag = String.fromCharCode(...head.slice(0, 4)) + String.fromCharCode(...head.slice(8, 12));
    const bitmap = await createImageBitmap(blob);
    return { tag, width: bitmap.width, height: bitmap.height };
  })()`)
  check('the output really is a WebP file', decoded.tag === 'RIFFWEBP', String(decoded.tag))
  check('it decodes at the render resolution',
    decoded.width === 160 && decoded.height === 120,
    decoded.width + 'x' + decoded.height)

  // Transparency has to survive. The ffmpeg command line flattens to yuv420p
  // and loses it, which would quietly ruin a folder of character sprites.
  const alphaSrc = path.join(renderSrc, 'zz_alpha_test.png')
  // Drawn by the page rather than pasted in as base64: a hand-written PNG that
  // turns out to be malformed fails the same way a lost alpha channel would.
  const alphaB64 = await js(`(async () => {
    const canvas = new OffscreenCanvas(64, 64);
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, 64, 64);
    ctx.fillStyle = 'rgba(255,0,0,1)';
    ctx.fillRect(16, 16, 32, 32);
    const buf = new Uint8Array(await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer());
    let s = '';
    for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
    return btoa(s);
  })()`)
  await fs.writeFile(alphaSrc, Buffer.from(alphaB64, 'base64'))
  const alpha = await js(`(async () => {
    const root = ${JSON.stringify(root)};
    const id = ${JSON.stringify(renders.episodeId)};
    const results = await window.api.convertRenders(root, id, ['zz_alpha_test.png']);
    if (!results[0]?.ok) return { stage: results[0]?.error ?? 'no result' };

    const target = ${JSON.stringify(path.join(root, 'game', 'images', 'ch9').replace('\\', '/'))};
    const url = 'file:///' + (target + '/zz_alpha_test.webp').replace(/\\\\/g, '/');
    const bitmap = await createImageBitmap(await (await fetch(url)).blob());
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bitmap, 0, 0);
    const data = ctx.getImageData(0, 0, bitmap.width, bitmap.height).data;
    let min = 255, max = 0;
    for (let i = 3; i < data.length; i += 4) {
      min = Math.min(min, data[i]);
      max = Math.max(max, data[i]);
    }
    return { stage: 'ok', minAlpha: min, maxAlpha: max };
  })()`)
  check('a transparent render converts', alpha.stage === 'ok', String(alpha.stage))
  check('transparency survives the conversion',
    alpha.minAlpha === 0 && alpha.maxAlpha === 255,
    'alpha ranged ' + alpha.minAlpha + '-' + alpha.maxAlpha)
  await fs.rm(alphaSrc, { force: true })

  // A re-render, dated ahead of the clock the way a copy off another machine
  // can be. The output must still settle after one conversion.
  const touched = new Date(Date.now() + 600000)
  await fs.utimes(path.join(renderSrc, names[0]), touched, touched)
  const rescan = await js(`(async () => {
    const after = await window.api.planRenderSync(${JSON.stringify(root)}, ${JSON.stringify(renders.episodeId)});
    return after.items.map(i => ({ name: i.name, status: i.status }));
  })()`)
  check('a re-rendered source becomes stale',
    rescan.find(i => i.name === names[0])?.status === 'stale' &&
    rescan.find(i => i.name === names[1])?.status === 'current',
    JSON.stringify(rescan))

  const redo = await js(`(async () => {
    const root = ${JSON.stringify(root)};
    const id = ${JSON.stringify(renders.episodeId)};
    const results = await window.api.convertRenders(root, id, ${JSON.stringify([names[0]])});
    const after = await window.api.planRenderSync(root, id);
    return { ok: results.every(r => r.ok), statuses: after.items.map(i => i.status) };
  })()`)
  check('converting the stale one settles it for good',
    redo.ok === true && redo.statuses.every(s => s === 'current'), JSON.stringify(redo))

  // ffmpeg remains selectable, and its absence is still reported clearly.
  if (ffmpeg) {
    const viaFfmpeg = await js(`(async () => {
      const root = ${JSON.stringify(root)};
      const id = ${JSON.stringify(renders.episodeId)};
      const opened = await window.api.openProject(root);
      await window.api.updateSettings(root, {
        ...opened.project.settings, renderEncoder: 'ffmpeg', ffmpegPath: ${JSON.stringify(ffmpeg)}
      });
      const status = await window.api.checkFfmpeg(root);
      const results = await window.api.convertRenders(root, id, ${JSON.stringify([names[1]])});
      return { status, ok: results.every(r => r.ok), bytes: results[0]?.bytes, error: results[0]?.error };
    })()`)
    check('ffmpeg is still a working choice',
      viaFfmpeg.ok === true && viaFfmpeg.bytes > 0, String(viaFfmpeg.error))
    check('and reports its own version when chosen',
      (viaFfmpeg.status.version ?? '').toLowerCase().includes('ffmpeg'),
      String(viaFfmpeg.status.version))
  }

  console.log('\n[including sub-folders]')
  // Off by default, and the folder is mirrored rather than flattened when on.
  await fs.mkdir(path.join(renderSrc, 'scene_a'), { recursive: true })
  await fs.copyFile(
    path.join(renderSrc, copied[0]),
    path.join(renderSrc, 'scene_a', 'shot_01.png')
  )
  await fs.copyFile(
    path.join(renderSrc, copied[0]),
    path.join(renderSrc, 'old', 'shot_01.png')
  )

  const subs = await js(`(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms * ${PACE}));
    document.querySelector('.episode-row').dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true, clientX: 200, clientY: 200
    }));
    await wait(250);
    Array.from(document.querySelectorAll('.ctx-item'))
      .find(b => b.textContent.indexOf('renders') !== -1).click();
    await wait(1500);

    const box = Array.from(document.querySelectorAll('.renders-modal input[type=checkbox]'))[0];
    if (!box) return { stage: 'no checkbox' };
    const before = {
      checked: box.checked,
      rows: Array.from(document.querySelectorAll('.rs-list li .rs-name')).map(e => e.textContent),
      convert: Array.from(document.querySelectorAll('.renders-modal .actions-row button'))
        .find(b => b.classList.contains('primary'))?.textContent ?? null
    };

    box.click();
    await wait(200);
    const saveButton = Array.from(document.querySelectorAll('.renders-modal button'))
      .find(b => b.textContent === 'Save and scan');
    if (!saveButton) return { stage: 'no save button after toggling', before };
    saveButton.click();
    await wait(1800);

    const after = {
      rows: Array.from(document.querySelectorAll('.rs-list li')).map(li => ({
        name: li.querySelector('.rs-name')?.textContent,
        out: li.querySelector('.rs-out')?.textContent
      })),
      counts: Array.from(document.querySelectorAll('.rs-count')).map(e => e.textContent)
    };

    // Convert, so the nested output can be looked for on disk.
    Array.from(document.querySelectorAll('.renders-modal .actions-row button'))
      .find(b => b.classList.contains('primary')).click();
    await wait(6000);
    const done = document.querySelector('.rs-done')?.textContent ?? null;

    Array.from(document.querySelectorAll('.renders-modal button'))
      .find(b => b.textContent === 'Close').click();
    await wait(300);
    return { stage: 'ok', before, after, done };
  })()`)

  check('the panel offers the sub-folder option', subs.stage === 'ok', String(subs.stage))
  check('it starts switched off', subs.before?.checked === false, String(subs.before?.checked))
  check('nothing nested is listed while it is off',
    (subs.before?.rows ?? []).every(n => !n.includes('/')), JSON.stringify(subs.before?.rows))
  check('switching it on brings the nested renders in',
    (subs.after?.rows ?? []).some(r => r.name === 'scene_a/shot_01.png') &&
    (subs.after?.rows ?? []).some(r => r.name === 'old/shot_01.png'),
    JSON.stringify(subs.after?.rows?.map(r => r.name)))
  check('the output keeps the folder rather than flattening it',
    (subs.after?.rows ?? []).find(r => r.name === 'scene_a/shot_01.png')?.out ===
      'scene_a/shot_01.webp',
    JSON.stringify(subs.after?.rows?.map(r => r.out)))
  check('the two same-named shots are told apart',
    new Set((subs.after?.rows ?? []).filter(r => r.name.endsWith('shot_01.png')).map(r => r.out))
      .size === 2,
    JSON.stringify(subs.after?.rows?.filter(r => r.name.endsWith('shot_01.png')).map(r => r.out)))

  const nestedOut = path.join(root, 'game', 'images', 'ch9', 'scene_a', 'shot_01.webp')
  const nestedStat = await fs.stat(nestedOut).catch(() => null)
  check('the nested render is written into a mirrored folder',
    (nestedStat?.size ?? 0) > 0, nestedOut + ' -> ' + String(nestedStat?.size))

  const settled = await js(`(async () => {
    const plan = await window.api.planRenderSync(${JSON.stringify(root)}, ${JSON.stringify(renders.episodeId)});
    return plan.items.map(i => ({ name: i.name, status: i.status }));
  })()`)
  check('a rescan finds the nested outputs up to date',
    settled.every(i => i.status === 'current'),
    JSON.stringify(settled.filter(i => i.status !== 'current')))

  // Back off again, and the nested renders drop out of the plan.
  await js(`window.api.setEpisodeRenders(${JSON.stringify(root)}, ${JSON.stringify(renders.episodeId)}, {
    sourceDir: ${JSON.stringify(renderSrc)}, targetSubdir: 'ch9', includeSubfolders: false
  })`)
  const backOff = await js(`(async () => {
    const plan = await window.api.planRenderSync(${JSON.stringify(root)}, ${JSON.stringify(renders.episodeId)});
    return { names: plan.items.map(i => i.name), ignored: plan.ignoredDirs };
  })()`)
  check('turning it off leaves the nested renders alone again',
    backOff.names.every(n => !n.includes('/')), JSON.stringify(backOff.names))
  check('and the skipped folders are named again',
    backOff.ignored.includes('scene_a') && backOff.ignored.includes('old'),
    JSON.stringify(backOff.ignored))

  console.log('\n[machine-local settings stay off the shared sidecar]')
  // The sidecar is meant to be committed and opened by someone else. A path to
  // a Blender folder on this computer is wrong everywhere else, so it has to
  // live beside the project registry instead.
  const sidecarFile = path.join(root, '.renpywriter', 'project.json')
  const machineFile = path.join(app.getPath('userData'), 'machine.json')
  const readJson = async (f) => JSON.parse(await fs.readFile(f, 'utf8'))

  const sidecarNow = await readJson(sidecarFile)
  const machineNow = await readJson(machineFile).catch(() => ({ projects: {} }))
  const mine = machineNow.projects?.[sidecarNow.id] ?? {}

  check('the render folder is not in the shared file',
    sidecarNow.episodes.every(e => !e.renders?.sourceDir),
    JSON.stringify(sidecarNow.episodes.map(e => e.renders)))
  check('it is stored for this machine instead',
    mine.renderSources?.[renders.episodeId] === renderSrc,
    JSON.stringify(mine.renderSources))
  check('what belongs to the project still travels',
    sidecarNow.episodes.some(e => e.renders?.targetSubdir === 'ch9'),
    JSON.stringify(sidecarNow.episodes.map(e => e.renders)))
  check('the encoder choice is not in the shared file',
    sidecarNow.settings.ffmpegPath === undefined && sidecarNow.settings.renderEncoder === undefined,
    JSON.stringify(sidecarNow.settings))
  check('the project settings that do travel are intact',
    sidecarNow.settings.sourceLanguage === 'cs' && sidecarNow.settings.scriptDir === 'scripts',
    JSON.stringify(sidecarNow.settings))
  check('nothing in the shared file names this computer',
    !JSON.stringify(sidecarNow).includes('C:\\'), JSON.stringify(sidecarNow).slice(0, 200))

  // Everything still works through the merged view the app sees.
  const merged = await js(`(async () => {
    const opened = await window.api.openProject(${JSON.stringify(root)});
    const ep = opened.episodes.find(e => e.id === ${JSON.stringify(renders.episodeId)});
    return {
      sourceDir: ep?.renders?.sourceDir ?? null,
      targetSubdir: ep?.renders?.targetSubdir ?? null,
      encoder: opened.project.settings.renderEncoder ?? null
    };
  })()`)
  check('the app still sees one merged config',
    merged.sourceDir === renderSrc && merged.targetSubdir === 'ch9',
    JSON.stringify(merged))

  // A sidecar written before the split must be cleaned up on open.
  const legacy = JSON.parse(JSON.stringify(sidecarNow))
  legacy.settings.ffmpegPath = 'C:\\legacy\\ffmpeg.exe'
  legacy.settings.renderEncoder = 'ffmpeg'
  legacy.episodes[0].renders = {
    sourceDir: 'C:\\legacy\\renders',
    targetSubdir: 'ch9'
  }
  await fs.writeFile(sidecarFile, JSON.stringify(legacy, null, 2), 'utf8')
  await fs.writeFile(machineFile, JSON.stringify({ version: 1, projects: {} }, null, 2), 'utf8')

  const migrated = await js(`window.api.openProject(${JSON.stringify(root)})`)
  const afterFile = await readJson(sidecarFile)
  const afterMachine = (await readJson(machineFile)).projects[sidecarNow.id]

  check('an old sidecar is cleaned as soon as it is opened',
    afterFile.settings.ffmpegPath === undefined &&
    afterFile.episodes.every(e => !e.renders?.sourceDir),
    JSON.stringify(afterFile.settings) + ' ' + JSON.stringify(afterFile.episodes[0].renders))
  check('the values it held are kept for this machine',
    afterMachine.ffmpegPath === 'C:\\legacy\\ffmpeg.exe' &&
    afterMachine.renderEncoder === 'ffmpeg' &&
    afterMachine.renderSources[legacy.episodes[0].id] === 'C:\\legacy\\renders',
    JSON.stringify(afterMachine))
  check('and the app reads them back unchanged',
    migrated.project.settings.ffmpegPath === 'C:\\legacy\\ffmpeg.exe' &&
    migrated.episodes.find(e => e.id === legacy.episodes[0].id)?.renders?.sourceDir ===
      'C:\\legacy\\renders',
    JSON.stringify(migrated.project.settings))
  check('the target folder survived the migration',
    afterFile.episodes.find(e => e.id === legacy.episodes[0].id)?.renders?.targetSubdir === 'ch9',
    JSON.stringify(afterFile.episodes.find(e => e.id === legacy.episodes[0].id)?.renders))

  // A machine that has never seen the render folder gets an empty one, not a
  // path belonging to someone else.
  await fs.writeFile(machineFile, JSON.stringify({ version: 1, projects: {} }, null, 2), 'utf8')
  const ms_fresh = await js(`(async () => {
    const opened = await window.api.openProject(${JSON.stringify(root)});
    const ep = opened.episodes.find(e => e.id === ${JSON.stringify(renders.episodeId)});
    const plan = await window.api.planRenderSync(${JSON.stringify(root)}, ep.id);
    return { sourceDir: ep?.renders?.sourceDir ?? null, planError: plan.error ?? null };
  })()`)
  check('a fresh clone has no render folder set',
    !ms_fresh.sourceDir, String(ms_fresh.sourceDir))
  check('and says so rather than failing oddly',
    (ms_fresh.planError ?? '').includes('No render folder'), String(ms_fresh.planError))

  // Put this machine's real settings back for the rest of the run.
  await js(`window.api.setEpisodeRenders(${JSON.stringify(root)}, ${JSON.stringify(renders.episodeId)}, {
    sourceDir: ${JSON.stringify(renderSrc)}, targetSubdir: 'ch9', includeSubfolders: false
  })`)

  console.log('\n[sync]')
  // A real repository with a real remote, driven through the panel.
  const gitRun = (cwd, args) =>
    new Promise((resolve) => {
      const child = spawn('git', args, { cwd, stdio: 'ignore' })
      child.on('error', () => resolve(-1))
      child.on('close', (code) => resolve(code ?? -1))
    })

  const syncBase = path.join(os.tmpdir(), `rpw-sync-${Date.now()}`)
  await fs.mkdir(syncBase, { recursive: true })
  const gitOk = (await gitRun(syncBase, ['--version'])) === 0
  check('git is available for the sync checks', gitOk)

  if (gitOk) {
    // Turn the fixture project into a clone of a remote, so the panel has
    // something true to report.
    const remote = path.join(syncBase, 'remote.git')
    await gitRun(syncBase, ['init', '--bare', '--initial-branch=main', remote])
    await gitRun(root, ['init', '--initial-branch=main'])
    await gitRun(root, ['config', 'user.name', 'Tester'])
    await gitRun(root, ['config', 'user.email', 'tester@example.com'])
    await gitRun(root, ['remote', 'add', 'origin', remote])
    await gitRun(root, ['add', '--', 'game'])
    await gitRun(root, ['commit', '-m', 'Initial'])
    await gitRun(root, ['push', '-u', 'origin', 'main'])

    const openPanel = async () => {
      await js(`(async () => {
        const wait = (ms) => new Promise(r => setTimeout(r, ms * ${PACE}));
        Array.from(document.querySelectorAll('.mode-switch button'))
          .find(b => b.textContent === 'Sync').click();
        await wait(1200);
      })()`)
    }

    await openPanel()
    const opened = await js(`(() => ({
      panel: !!document.querySelector('.sync-modal'),
      branch: document.querySelector('.sb-branch')?.textContent ?? null,
      upstream: document.querySelector('.sb-upstream')?.textContent ?? null,
      groups: Array.from(document.querySelectorAll('.sg-name')).map(e => e.textContent),
      counts: Array.from(document.querySelectorAll('.sg-count')).map(e => e.textContent),
      primary: Array.from(document.querySelectorAll('.sync-modal .actions-row button'))
        .find(b => b.classList.contains('primary'))?.textContent ?? null
    }))()`)

    check('the sync panel opens', opened.panel === true, JSON.stringify(opened))
    check('it names the branch and where it goes',
      opened.branch === 'main' && opened.upstream === 'origin/main',
      opened.branch + ' -> ' + opened.upstream)
    check('it groups changes by what they are',
      opened.groups.includes('Characters, notes and outline'), JSON.stringify(opened.groups))
    // The base stylesheet gives every input width:100%, which is right for a
    // text field and disastrous for a checkbox: it becomes a 590px box that
    // pushes its own label off the row. Checked here because it is invisible
    // to any test that only looks at the DOM.
    const layout = await js(`(() => {
      const box = document.querySelector('.sg-files input[type=checkbox]');
      const row = document.querySelector('.sg-files li');
      const path = document.querySelector('.sg-path');
      const dir = document.querySelector('.sg-dir');
      const file = document.querySelector('.sg-file');
      const rows = Array.from(document.querySelectorAll('.sg-files li')).slice(0, 5);
      return {
        checkboxWidth: box ? Math.round(box.getBoundingClientRect().width) : null,
        rowWidth: row ? Math.round(row.getBoundingClientRect().width) : null,
        rowRight: row ? Math.round(row.getBoundingClientRect().right) : null,
        listRight: Math.round(document.querySelector('.sync-groups').getBoundingClientRect().right),
        lefts: [...new Set(rows.map(r => Math.round(r.getBoundingClientRect().x)))],
        rebuilt: dir && file ? dir.textContent + file.textContent : null,
        titled: path?.getAttribute('title') ?? null
      };
    })()`)
    check('a checkbox stays checkbox-sized',
      layout.checkboxWidth !== null && layout.checkboxWidth < 30, String(layout.checkboxWidth))
    check('rows line up instead of staggering',
      layout.lefts.length === 1, JSON.stringify(layout.lefts))
    check('rows stay inside the list',
      layout.rowRight <= layout.listRight, layout.rowRight + ' vs ' + layout.listRight)
    check('a path reads as itself, punctuation and all',
      layout.rebuilt === layout.titled, layout.rebuilt + ' vs ' + layout.titled)
    check('a dotted path keeps its leading dot',
      (layout.titled ?? '').startsWith('.') ? (layout.rebuilt ?? '').startsWith('.') : true,
      String(layout.rebuilt))

    check('the save button says how much it will save',
      /^Save and send \d+ file/.test(opened.primary ?? ''), String(opened.primary))

    // Save everything, which should reach the remote.
    const saved = await js(`(async () => {
      const wait = (ms) => new Promise(r => setTimeout(r, ms * ${PACE}));
      const input = document.querySelector('.sync-modal .field input');
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
        .call(input, 'Sidecar and notes');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await wait(200);
      Array.from(document.querySelectorAll('.sync-modal .actions-row button'))
        .find(b => b.classList.contains('primary')).click();
      await wait(4000);
      return {
        ok: !!document.querySelector('.sync-ok'),
        text: document.querySelector('.sync-ok')?.textContent
          ?? document.querySelector('.sync-modal .error')?.textContent ?? null,
        remaining: document.querySelectorAll('.sg-files li').length
      };
    })()`)
    check('saving succeeds', saved.ok === true, String(saved.text))
    check('it says the work was sent, and how much',
      /Sent \d+ commits? to origin\./.test(saved.text ?? ''),
      String(saved.text))
    check('nothing is left waiting afterwards', saved.remaining === 0, String(saved.remaining))

    // A second machine sees it, images and all.
    const other = path.join(syncBase, 'other')
    await gitRun(syncBase, ['clone', '--quiet', remote, other])
    const sidecarThere = await fs
      .readFile(path.join(other, '.renpywriter', 'project.json'), 'utf8')
      .catch(() => null)
    check('another machine receives the sidecar', (sidecarThere ?? '').includes('episodes'),
      String(sidecarThere).slice(0, 40))
    const imageThere = await fs
      .stat(path.join(other, 'game', 'images', 'ch9', 'scene_a', 'shot_01.webp'))
      .catch(() => null)
    check('and the converted renders, nested folders included',
      (imageThere?.size ?? 0) > 0, String(imageThere?.size))

    // Their change comes back the other way.
    await fs.writeFile(path.join(other, '.renpywriter', 'notes.json'), '{"notes":[],"v":2}')
    await gitRun(other, ['config', 'user.name', 'Other'])
    await gitRun(other, ['config', 'user.email', 'other@example.com'])
    await gitRun(other, ['add', '--', '.renpywriter/notes.json'])
    await gitRun(other, ['commit', '-m', 'Their note'])
    await gitRun(other, ['push'])

    const brought = await js(`(async () => {
      const wait = (ms) => new Promise(r => setTimeout(r, ms * ${PACE}));
      Array.from(document.querySelectorAll('.sync-modal button'))
        .find(b => b.textContent.indexOf('Bring in') !== -1).click();
      await wait(4000);
      return document.querySelector('.sync-ok')?.textContent
        ?? document.querySelector('.sync-modal .error')?.textContent ?? null;
    })()`)
    check('bringing in their work reports what arrived',
      (brought ?? '').includes('Pulled 1'), String(brought))
    const landed = await fs.readFile(path.join(root, '.renpywriter', 'notes.json'), 'utf8')
    check('and it is on disk here', landed.includes('"v":2'), landed)

    await js(`document.querySelector('.modal-backdrop')?.click()`)
    await sleep(400)

    // Converting renders should be able to end with them saved, rather than
    // leaving a folder of files no other machine can see.
    const newRender = path.join(renderSrc, 'ch9_2_saved_by_panel.png')
    await fs.copyFile(path.join(renderSrc, copied[0]), newRender)

    const savedRenders = await js(`(async () => {
      const wait = (ms) => new Promise(r => setTimeout(r, ms * ${PACE}));
      document.querySelector('.episode-row').dispatchEvent(new MouseEvent('contextmenu', {
        bubbles: true, clientX: 200, clientY: 200
      }));
      await wait(250);
      Array.from(document.querySelectorAll('.ctx-item'))
        .find(b => b.textContent.indexOf('renders') !== -1).click();
      await wait(1800);

      const convert = Array.from(document.querySelectorAll('.renders-modal .actions-row button'))
        .find(b => b.classList.contains('primary'));
      if (!convert || convert.disabled) return { stage: 'nothing to convert: ' + convert?.textContent };
      convert.click();
      await wait(8000);

      const offer = document.querySelector('.rs-save button');
      if (!offer) return { stage: 'no save offer', done: document.querySelector('.rs-done')?.textContent };
      const label = offer.textContent;
      offer.click();
      await wait(6000);

      const saved = document.querySelector('.rs-saved')?.textContent
        ?? document.querySelector('.rs-save .error')?.textContent ?? null;
      Array.from(document.querySelectorAll('.renders-modal button'))
        .find(b => b.textContent === 'Close').click();
      await wait(300);
      return { stage: 'ok', label, saved };
    })()`)

    check('the render panel offers to save what it converted',
      savedRenders.stage === 'ok', JSON.stringify(savedRenders))
    check('the offer says how many it would save',
      /Save these \d+ image/.test(savedRenders.label ?? ''), String(savedRenders.label))
    check('saving them reports success',
      /Sent \d+ commits? to origin\./.test(savedRenders.saved ?? ''),
      String(savedRenders.saved))

    const committedNames = await new Promise((resolve) => {
      const child = spawn('git', ['show', '--name-only', '--format=%s', 'HEAD'], {
        cwd: root, stdio: ['ignore', 'pipe', 'ignore']
      })
      let out = ''
      child.stdout.on('data', (d) => (out += String(d)))
      child.on('close', () => resolve(out))
      child.on('error', () => resolve(''))
    })
    check('the commit message names the episode',
      committedNames.includes('Renders for Chapter 2'), committedNames.split('\n')[0])
    check('and it contains the converted image',
      committedNames.includes('ch9_2_saved_by_panel.webp'),
      committedNames.split('\n').filter(Boolean).slice(0, 4).join(' | '))
    const stillPending = await js(
    '(async () => {' +
    '  const s = await window.api.gitStatus(' + JSON.stringify(root) + ');' +
    '  return s.changes.filter(c => c.path.indexOf("ch9_2_saved_by_panel.webp") !== -1)' +
    '    .map(c => c.state + " " + c.path);' +
    '})()'
  )
  // Only the output matters: the source PNG sits inside the fixture root, which
  // a real render folder never does.
  check('the converted image is not left pending afterwards',
    Array.isArray(stillPending) && stillPending.length === 0, JSON.stringify(stillPending))

    await fs.rm(newRender, { force: true })
    // The repository and its remote stay: the HTTP section commits through
    // them to check that history names the person who signed in.
  }

  console.log('\n[the same app over HTTP]')
  // The real server, and the real interface loaded from it in a window with no
  // preload at all -- so there is no window.api to fall back on and every call
  // must go over HTTP. This is what a browser does.
  const { startServer } = await import('./.server-bundle.mjs')
  const serverData = path.join(os.tmpdir(), `rpw-serverdata-${Date.now()}`)
  const running = await startServer({
    dataDir: serverData,
    webRoot: path.join(out, 'renderer'),
    projects: [root]
  })
  check('the server starts on loopback', running.port > 0, String(running.port))

  const refusedFlag = await startServer({ dataDir: serverData, host: '0.0.0.0' }).then(
    () => null,
    (e) => e.message
  )
  check('being reachable from a network has to be asked for',
    (refusedFlag ?? '').includes('--allow-network'), String(refusedFlag))

  const refusedEmpty = await startServer({
    dataDir: serverData, host: '0.0.0.0', allowNetwork: true
  }).then(() => null, (e) => e.message)
  check('and is refused while there are no accounts to sign in as',
    (refusedEmpty ?? '').includes('no accounts'), String(refusedEmpty))

  // Nothing at all is readable without a session.
  const { createUserStore: makeUsers } = await import('./.users-bundle.mjs')
  const post = async (route, body, cookie) => {
    const response = await fetch(`http://127.0.0.1:${running.port}${route}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      body: JSON.stringify(body)
    })
    const text = await response.text()
    let json = null
    try { json = JSON.parse(text) } catch { /* not json */ }
    return { status: response.status, json, setCookie: response.headers.get('set-cookie') }
  }

  const anonymous = await post('/api/episodes:read', [root, 'chapter_2.rpy'])
  check('a script cannot be read without signing in', anonymous.status === 401,
    String(anonymous.status))
  const anonymousWrite = await post('/api/episodes:write', [root, 'chapter_2.rpy', 'wiped'])
  check('and certainly cannot be written', anonymousWrite.status === 401,
    String(anonymousWrite.status))
  const stillThere = await fs.readFile(path.join(root, 'game', 'scripts', 'chapter_2.rpy'), 'utf8')
  check('the refused write changed nothing', stillThere !== 'wiped' && stillThere.length > 100,
    String(stillThere.length))

  // Accounts, made the way the command line makes them.
  const accounts = makeUsers(serverData)
  await accounts.create({ username: 'jan', password: 'a long enough password', role: 'admin' })
  await accounts.create({ username: 'pat', password: 'another long password', role: 'proofreader' })
  await accounts.create({ username: 'sam', password: 'a third long password', role: 'viewer' })

  const wrongPassword = await post('/auth/login', { username: 'jan', password: 'not it' })
  check('a wrong password is refused', wrongPassword.status === 401, String(wrongPassword.status))
  const unknownName = await post('/auth/login', { username: 'nobody', password: 'not it' })
  check('an unknown account gives exactly the same answer',
    unknownName.status === wrongPassword.status &&
    unknownName.json.error === wrongPassword.json.error,
    JSON.stringify([unknownName.json, wrongPassword.json]))

  const signedIn = await post('/auth/login', { username: 'jan', password: 'a long enough password' })
  check('the right password signs in', signedIn.status === 200, String(signedIn.status))
  check('and returns the account without anything secret in it',
    signedIn.json.value.username === 'jan' && signedIn.json.value.role === 'admin' &&
    !JSON.stringify(signedIn.json).includes('hash') &&
    !JSON.stringify(signedIn.json).includes('salt'),
    JSON.stringify(signedIn.json))
  check('the session cookie cannot be read by script',
    (signedIn.setCookie ?? '').includes('HttpOnly'), String(signedIn.setCookie))
  check('and is not sent on requests other sites start',
    (signedIn.setCookie ?? '').includes('SameSite=Strict'), String(signedIn.setCookie))

  const adminCookie = (signedIn.setCookie ?? '').split(';')[0]
  const asAdmin = await post('/api/episodes:read', [root, 'chapter_2.rpy'], adminCookie)
  check('a signed-in admin can read a script', asAdmin.status === 200, String(asAdmin.status))

  const forged = await post('/api/episodes:read', [root, 'chapter_2.rpy'], 'rpw_session=guessed')
  check('an invented session is refused', forged.status === 401, String(forged.status))

  // Roles.
  const asProofreader = await post('/auth/login', {
    username: 'pat', password: 'another long password'
  })
  const proofCookie = (asProofreader.setCookie ?? '').split(';')[0]
  const proofRead = await post('/api/episodes:read', [root, 'chapter_2.rpy'], proofCookie)
  check('a proofreader can read', proofRead.status === 200, String(proofRead.status))
  const proofWrite = await post('/api/episodes:write', [root, 'chapter_2.rpy', 'wiped'], proofCookie)
  check('a proofreader cannot write yet', proofWrite.status === 403, String(proofWrite.status))
  check('and is told what is coming rather than just refused',
    (proofWrite.json?.error ?? '').includes('Suggestions'), String(proofWrite.json?.error))

  const asViewer = await post('/auth/login', { username: 'sam', password: 'a third long password' })
  const viewerCookie = (asViewer.setCookie ?? '').split(';')[0]
  const viewerWrite = await post('/api/git:commit', [root, { message: 'x', paths: ['a'] }], viewerCookie)
  check('a viewer cannot commit', viewerWrite.status === 403, String(viewerWrite.status))

  const untouched = await fs.readFile(path.join(root, 'game', 'scripts', 'chapter_2.rpy'), 'utf8')
  check('none of the refused writes touched the file', untouched === stillThere,
    String(untouched.length) + ' vs ' + String(stillThere.length))

  // A request that another site started is refused even with a valid cookie.
  const crossSite = await fetch(`http://127.0.0.1:${running.port}/api/episodes:read`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: 'https://somewhere.else',
      cookie: adminCookie
    },
    body: JSON.stringify([root, 'chapter_2.rpy'])
  })
  check('a request from another site is refused even with a good cookie',
    crossSite.status === 403, String(crossSite.status))

  // Signing out ends it.
  const out2 = await post('/auth/logout', {}, adminCookie)
  check('signing out is accepted', out2.status === 200, String(out2.status))
  const afterOut = await post('/api/episodes:read', [root, 'chapter_2.rpy'], adminCookie)
  check('and the session no longer works', afterOut.status === 401, String(afterOut.status))

  const web = new BrowserWindow({
    show: false,
    width: 1280,
    height: 860,
    webPreferences: { nodeIntegration: false, contextIsolation: true, backgroundThrottling: false }
  })
  const webProblems = []
  web.webContents.on('console-message', (event) => {
    if (event.level === 'error') webProblems.push(event.message)
  })
  await web.loadURL(`http://127.0.0.1:${running.port}/`)
  // Served over HTTP and asked to sign in: both take a round trip, and on a
  // slow machine they used to take longer than the wait that stood here.
  await settle(web.webContents, "document.querySelector('.gate-card input[type=password]')")

  const webJs = async (code) => {
    try {
      return await web.webContents.executeJavaScript(code)
    } catch (e) {
      problems.push('web executeJavaScript threw: ' + (e?.message ?? String(e)))
      return {}
    }
  }

  const bootstrapped = await webJs(`(() => ({
    hasBridge: !!window.api,
    connected: !!window.renpyWriter && !!window.renpyWriter.currentApi(),
    mounted: document.getElementById('root')?.childElementCount > 0,
    askingToSignIn: !!document.querySelector('input[type=password]'),
    heading: document.querySelector('.gate-card h1')?.textContent ?? null,
    projects: document.querySelectorAll('.project-item').length
  }))()`)
  check('the page has no Electron bridge at all', bootstrapped.hasBridge === false,
    String(bootstrapped.hasBridge))
  check('it connected itself to the server that served it',
    bootstrapped.connected === true, String(bootstrapped.connected))
  check('and the interface mounted', bootstrapped.mounted === true, String(bootstrapped.mounted))
  check('a stranger is asked to sign in', bootstrapped.askingToSignIn === true,
    String(bootstrapped.heading))
  check('and shown nothing of the work behind it', bootstrapped.projects === 0,
    String(bootstrapped.projects))

  // Sign in through the form, the way a person on a phone would.
  const signIn = await webJs(`(async () => {${UNTIL}
    const set = (el, value) => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
        .call(el, value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    };
    const fields = Array.from(document.querySelectorAll('.gate-card input'));
    set(fields[0], 'jan');
    set(fields[1], 'a long enough password');
    await wait(200);

    document.querySelector('.gate-card button.primary').click();
    // Signed in when the password field is gone, and the list is the next
    // thing to arrive.
    await until(() => !document.querySelector('input[type=password]'));
    await until(() => document.querySelectorAll('.project-item .name').length > 0);
    return {
      stillAsking: !!document.querySelector('input[type=password]'),
      heading: document.querySelector('.gate-card h1')?.textContent ?? null,
      projects: Array.from(document.querySelectorAll('.project-item .name')).map(e => e.textContent)
    };
  })()`)
  check('signing in through the form works', signIn.stillAsking === false,
    JSON.stringify(signIn))
  check('and the app itself is now on screen', signIn.heading === 'Ren’Py Writer',
    String(signIn.heading))
  // The list is the operator's, given at startup, so it is there immediately.
  check('and the project this server was given is already listed',
    (signIn.projects ?? []).includes('E2E Fixture'), JSON.stringify(signIn.projects))

  // Sign out and reload from this side. A page told to reload itself inside
  // executeJavaScript navigates away before it can answer, and the call never
  // comes back.
  await webJs(`fetch('/auth/logout', { method: 'POST', credentials: 'same-origin' })`)
  await web.reload()
  await settle(web.webContents, "document.querySelectorAll('.gate-card input').length >= 2")
  const rejected = await webJs(`(async () => {${UNTIL}
    const set = (el, value) => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
        .call(el, value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    };
    const fields = Array.from(document.querySelectorAll('.gate-card input'));
    if (fields.length < 2) return { stage: 'not asked to sign in' };
    set(fields[0], 'jan');
    set(fields[1], 'the wrong password');
    await wait(200);
    document.querySelector('.gate-card button.primary').click();
    await until(() => document.querySelector('.gate-card .error'));
    return {
      stage: 'ok',
      error: document.querySelector('.gate-card .error')?.textContent ?? null,
      stillAsking: !!document.querySelector('input[type=password]')
    };
  })()`)
  check('a wrong password is shown as a plain message', rejected.stage === 'ok' &&
    (rejected.error ?? '').includes('do not match'), JSON.stringify(rejected))
  check('and the sign-in screen stays put', rejected.stillAsking === true,
    String(rejected.stillAsking))

  // Back in, for everything below.
  await webJs(`(async () => {${UNTIL}
    const set = (el, value) => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
        .call(el, value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    };
    const fields = Array.from(document.querySelectorAll('.gate-card input'));
    set(fields[0], 'jan');
    set(fields[1], 'a long enough password');
    await wait(200);
    document.querySelector('.gate-card button.primary').click();
    await until(() => !document.querySelector('input[type=password]'));
  })()`)
  // Nothing below this line works until the connection is signed in.
  await settle(web.webContents, "!document.querySelector('input[type=password]')")

  const overHttp = await webJs(`(async () => {
    const call = (name, ...args) => window.renpyWriter.currentApi()[name](...args);
    const listing = await call('listProjects');
    const opened = await call('openProject', ${JSON.stringify(root)});
    const parsed = await call('parseEpisode', ${JSON.stringify(root)}, 'chapter_2.rpy');
    const script = await call('readEpisode', ${JSON.stringify(root)}, 'chapter_2.rpy');
    const status = await call('gitStatus', ${JSON.stringify(root)});
    const encoder = await call('checkFfmpeg', ${JSON.stringify(root)});

    let refusedCall = null;
    try {
      await call('openProject', '/definitely/not/a/project');
    } catch (e) {
      refusedCall = e.message;
    }

    return {
      registryPath: listing.path,
      projectName: opened.project.name,
      episodes: opened.episodes.length,
      beats: parsed.labels.length,
      scriptStart: script.slice(0, 24),
      branch: status.branch,
      isRepo: status.isRepo,
      gitError: status.error ?? null,
      encoderOk: encoder.ok,
      error: refusedCall
    };
  })()`)

  check('the app reads a project over HTTP', overHttp.projectName === 'E2E Fixture',
    JSON.stringify(overHttp))
  check('and its episodes', (overHttp.episodes ?? 0) > 0, String(overHttp.episodes))
  check('and parses a script through the same core', overHttp.beats === 9, String(overHttp.beats))
  check('and reads the script text itself',
    (overHttp.scriptStart ?? '').includes('label'), String(overHttp.scriptStart))
  check('git status travels over HTTP intact',
    typeof overHttp.isRepo === 'boolean' &&
    (overHttp.isRepo ? overHttp.branch !== undefined : !!overHttp.gitError),
    JSON.stringify({ isRepo: overHttp.isRepo, branch: overHttp.branch, error: overHttp.gitError }))
  check('the server keeps its own project list, not the desktop one',
    (overHttp.registryPath ?? '').includes('rpw-serverdata'), String(overHttp.registryPath))
  check('a failure arrives as the app own message',
    (overHttp.error ?? '').includes('not one this server was given'), String(overHttp.error))
  check('the server admits it has no built-in encoder', overHttp.encoderOk === false,
    String(overHttp.encoderOk))

  // The gate drew before the server knew about any project, and it has no
  // reason to poll. Reload the page the way a person would.
  await web.reload()
  await settle(web.webContents, "document.querySelector('.project-item .name')")

  // A whole screen drawn from data that only came over HTTP.
  const drawn = await webJs(`(async () => {
    const items = Array.from(document.querySelectorAll('.project-item .name')).map(e => e.textContent);
    if (items.length === 0) return { items };
    document.querySelector('.project-item').click();
    await new Promise(r => setTimeout(r, 3000));
    return {
      items,
      opened: document.querySelector('.switcher-name')?.textContent ?? null,
      episodes: document.querySelectorAll('.episode-row').length,
      beats: document.querySelectorAll('.beat-row').length
    };
  })()`)
  check('the gate lists the projects the server knows',
    (drawn.items ?? []).includes('E2E Fixture'), JSON.stringify(drawn.items))
  check('opening one draws the outline from HTTP data',
    drawn.opened === 'E2E Fixture' && (drawn.beats ?? 0) > 0,
    JSON.stringify({ opened: drawn.opened, beats: drawn.beats }))
  check('nothing errored in the browser page', webProblems.length === 0,
    JSON.stringify(webProblems.slice(0, 2)))

  // What a host cannot do, it does not offer. The browser has no Blender
  // folder, no encoder and no artwork, so those features are absent rather
  // than present-and-explaining.
  const webMenu = await webJs(`(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms * ${PACE}));
    const caps = await window.renpyWriter.currentApi().capabilities();
    const row = document.querySelector('.episode-row');
    if (!row) return { caps, labels: null };
    row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 150, clientY: 150 }));
    await wait(300);
    const labels = Array.from(document.querySelectorAll('.ctx-item')).map(b => b.textContent);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await wait(200);
    return { caps, labels };
  })()`)

  check('the server says what it cannot do',
    webMenu.caps && webMenu.caps.renderSync === false && webMenu.caps.imagePreviews === false &&
    webMenu.caps.folderPicker === false && webMenu.caps.manageProjects === false,
    JSON.stringify(webMenu.caps))

  // The operator's list is the whole of what the app can reach on this machine.
  const outsideList = await webJs(`(async () => {
    try {
      await window.renpyWriter.currentApi().openProject('C:' + String.fromCharCode(92) + 'Windows');
      return 'allowed';
    } catch (e) {
      return e.message;
    }
  })()`)
  check('a project the server was not given cannot be opened',
    (outsideList ?? '').includes('not one this server was given'), String(outsideList))

  const cannotAdd = await webJs(`(async () => {
    try {
      await window.renpyWriter.currentApi().createProject({
        name: 'Sneaky', renpyRoot: 'C:' + String.fromCharCode(92) + 'Windows',
        settings: { sourceLanguage: 'cs', targetLanguage: 'en', expressionsEnabled: false, linear: true, scriptDir: '' }
      });
      return 'allowed';
    } catch (e) {
      return e.message;
    }
  })()`)
  check('and none can be added from the app either',
    (cannotAdd ?? '').includes('set when the server starts'), String(cannotAdd))
  check('so the browser menu has no render entry',
    (webMenu.labels ?? []).every(l => !l.toLowerCase().includes('render')),
    JSON.stringify(webMenu.labels))
  check('and no translate or proofread entry',
    (webMenu.labels ?? []).every(l => !l.startsWith('Translate') && !l.startsWith('Proofread')),
    JSON.stringify(webMenu.labels))
  check('while the entries that do work are still there',
    (webMenu.labels ?? []).some(l => l.includes('draft')), JSON.stringify(webMenu.labels))

  // A phone stops timers the moment it is backgrounded. An edit made and then
  // switched away from inside the autosave debounce must still reach disk.
  const scriptPath = path.join(root, 'game', 'scripts', 'chapter_2.rpy')
  const beforeHide = await fs.readFile(scriptPath, 'utf8')
  const hidden = await webJs(`(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms * ${PACE}));
    const episode = Array.from(document.querySelectorAll('.episode-row'))
      .find(r => r.textContent.indexOf('chapter_2') !== -1);
    if (!episode) return { stage: 'no episode' };
    episode.click();
    await wait(2500);
    const writer = Array.from(document.querySelectorAll('.mode-switch button'))
      .find(b => b.textContent === 'Writer');
    if (writer) { writer.click(); await wait(1500); }

    const block = document.querySelector('.blk-text .blk-view');
    if (!block) return { stage: 'no line to edit' };
    block.click();
    await wait(600);
    const box = document.querySelector('.blk-text textarea, .blk-text input');
    if (!box) return { stage: 'no editor opened' };

    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(box), 'value').set
      .call(box, 'TYPED THEN BACKGROUNDED');
    box.dispatchEvent(new Event('input', { bubbles: true }));
    box.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));

    // Hidden well inside the 1200ms debounce, then barely any time at all.
    await wait(100);
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    await wait(400);
    return { stage: 'ok', status: document.querySelector('.statusbar')?.textContent ?? null };
  })()`)
  const afterHide = await fs.readFile(scriptPath, 'utf8')

  check('an edit can be made in the writer over HTTP', hidden.stage === 'ok',
    JSON.stringify(hidden))
  check('backgrounding the page writes it immediately, inside the debounce',
    afterHide.includes('TYPED THEN BACKGROUNDED'),
    (hidden.status ?? '').slice(-40))
  check('and the rest of the file is untouched',
    afterHide.length > beforeHide.length - 200, String(afterHide.length))

  // Coming back, another client's change is picked up.
  await fs.writeFile(scriptPath, afterHide + String.fromCharCode(10) + '# FROM ELSEWHERE' + String.fromCharCode(10), 'utf8')
  const returned = await webJs(`(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms * ${PACE}));
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    await wait(3000);
    const text = await window.renpyWriter.currentApi()
      .readEpisode(${JSON.stringify(root)}, 'chapter_2.rpy');
    const shown = Array.from(document.querySelectorAll('.blk-action .blk-view'))
      .some(e => e.textContent.indexOf('FROM ELSEWHERE') !== -1);
    return { onDisk: text.indexOf('FROM ELSEWHERE') !== -1, shown };
  })()`)
  check('a change made elsewhere is not clobbered on return',
    returned.onDisk === true, JSON.stringify(returned))
  check('and it appears in the open tab', returned.shown === true, JSON.stringify(returned))

  // Editing from the browser, which is the whole point of the phone.
  const before = await fs.readFile(path.join(root, 'game', 'scripts', 'chapter_2.rpy'), 'utf8')
  const edited = await webJs(`(async () => {
    const api = window.renpyWriter.currentApi();
    const original = await api.readEpisode(${JSON.stringify(root)}, 'chapter_2.rpy');
    const changed = original.replace('label ', 'label ');
    const marker = original + String.fromCharCode(10) + '# edited from a browser';
    await api.writeEpisode(${JSON.stringify(root)}, 'chapter_2.rpy', marker);
    const readBack = await api.readEpisode(${JSON.stringify(root)}, 'chapter_2.rpy');
    return { wrote: marker.length, readBack: readBack.length, ends: readBack.slice(-24) };
  })()`)
  const after = await fs.readFile(path.join(root, 'game', 'scripts', 'chapter_2.rpy'), 'utf8')
  check('an edit made in the browser reaches the file on disk',
    after.endsWith('# edited from a browser'), after.slice(-40))
  check('and reading it back over HTTP returns what was written',
    edited.readBack === edited.wrote && (edited.ends ?? '').includes('browser'),
    JSON.stringify(edited))
  check('nothing else in the script was disturbed',
    after.startsWith(before.slice(0, 200)), after.slice(0, 60))
  await fs.writeFile(path.join(root, 'game', 'scripts', 'chapter_2.rpy'), before, 'utf8')

  // Two things that only matter once a checkout is shared: whose name goes on
  // a commit, and whether the copy being served is current.
  const asPerson = await webJs(`(async () => {
    const api = window.renpyWriter.currentApi();
    const root = ${JSON.stringify(root)};
    const status = await api.gitStatus(root);
    if (!status.isRepo) return { stage: 'fixture is not a repo' };

    await api.writeEpisode(root, 'chapter_2.rpy',
      (await api.readEpisode(root, 'chapter_2.rpy')) + String.fromCharCode(10) + '# by whom');
    const result = await api.gitCommit(root, {
      message: 'Written from the web',
      paths: ['game/scripts/chapter_2.rpy']
    });
    return { stage: 'ok', ok: result.ok, message: result.message };
  })()`)
  check('a commit can be made from the browser', asPerson.ok === true,
    JSON.stringify(asPerson))

  const authored = await new Promise((resolve) => {
    const child = spawn('git', ['log', '-1', '--format=%an|%ae|%s'], {
      cwd: root, stdio: ['ignore', 'pipe', 'ignore']
    })
    let out = ''
    child.stdout.on('data', (d) => (out += String(d)))
    child.on('close', () => resolve(out.trim()))
    child.on('error', () => resolve(''))
  })
  check('and history names the signed-in person, not the server',
    authored.startsWith('jan|'), String(authored))
  check('with an address to attribute it to',
    (authored.split('|')[1] ?? '').includes('@'), String(authored))

  // A change pushed to the remote by somebody else is picked up when the
  // server next serves the project, without anyone pressing anything.
  // Nothing unsaved in the way: a fast-forward refuses if taking the incoming
  // change would overwrite local edits, which earlier tests leave plenty of.
  await gitRun(root, ['add', '--all'])
  await gitRun(root, ['commit', '-m', 'Everything else from the run'])

  // Send this machine's commit first. Cloning before that leaves the two
  // sides starting from different places, and a fast-forward pull will then
  // rightly refuse -- which is a different behaviour from the one under test.
  await gitRun(root, ['push', '--quiet'])

  const elsewhere = path.join(syncBase, 'elsewhere')
  await gitRun(syncBase, ['clone', '--quiet', path.join(syncBase, 'remote.git'), elsewhere])
  await gitRun(elsewhere, ['config', 'user.name', 'Other'])
  await gitRun(elsewhere, ['config', 'user.email', 'other@example.com'])
  await fs.writeFile(path.join(elsewhere, '.renpywriter', 'notes.json'), '{"notes":[],"v":9}')
  await gitRun(elsewhere, ['add', '--', '.renpywriter/notes.json'])
  await gitRun(elsewhere, ['commit', '-m', 'Their note'])
  await gitRun(elsewhere, ['push', '--quiet'])

  const pulled = await webJs(`(async () => {
    // Opening the project is what makes the server catch up.
    await window.renpyWriter.currentApi().openProject(${JSON.stringify(root)});
    return true;
  })()`)
  const theirNote = await fs.readFile(path.join(root, '.renpywriter', 'notes.json'), 'utf8')
  check('opening a project brings in what others pushed',
    theirNote.includes('"v":9'), theirNote.slice(0, 60))

  // Two people changing the same line is the case the whole sync design turns
  // on. Driven through the real panel, because a conflict that renders wrong
  // is a conflict nobody can answer.
  const clashNL = String.fromCharCode(10)
  const clashScript = path.join(root, 'game', 'scripts', 'chapter_2.rpy')

  await gitRun(root, ['add', '--all'])
  await gitRun(root, ['commit', '-m', 'Everything before the clash'])
  await gitRun(root, ['push', '--quiet'])

  const clashClone = path.join(syncBase, 'clash')
  await gitRun(syncBase, ['clone', '--quiet', path.join(syncBase, 'remote.git'), clashClone])
  await gitRun(clashClone, ['config', 'user.name', 'Other'])
  await gitRun(clashClone, ['config', 'user.email', 'other@example.com'])

  // Matched on the trimmed line rather than the whole one: a clone checks out
  // with the platform's line endings and the fixture was written with its
  // own, so an exact match finds nothing and quietly rewrites the file
  // unchanged -- which reads as "no conflict happened" rather than as a
  // broken test.
  const sameLine = (text, line) =>
    text.split(clashNL).find((l) => l.trim() === line.trim())

  const clashHereText = await fs.readFile(clashScript, 'utf8')
  const clashLine = clashHereText.split(clashNL).find((l) => /^\s+\w+ "/.test(l))
  check('the fixture has a line of dialogue to argue over', !!clashLine, String(clashLine))

  const clashTheirFile = path.join(clashClone, 'game', 'scripts', 'chapter_2.rpy')
  const clashTheirText = await fs.readFile(clashTheirFile, 'utf8')
  const theirLine = sameLine(clashTheirText, clashLine)
  await fs.writeFile(
    clashTheirFile,
    clashTheirText.replace(theirLine, theirLine.replace('"', '"Their take: '))
  )
  await gitRun(clashClone, ['commit', '-am', 'Their wording'])
  await gitRun(clashClone, ['push', '--quiet'])

  await fs.writeFile(
    clashScript,
    clashHereText.replace(clashLine, clashLine.replace('"', '"My take: '))
  )
  // Both edits have to have landed, or what follows tests nothing at all.
  check('the edit here really was written',
    (await fs.readFile(clashScript, 'utf8')).includes('My take: '), 'not written')
  check('and theirs really was sent',
    (await gitRun(root, ['fetch', '--quiet'])) === 0, 'fetch failed')

  const clashAsked = await webJs(`(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms * ${PACE}));
    const sync = Array.from(document.querySelectorAll('.mode-switch button'))
      .find(b => b.textContent === 'Sync');
    if (!sync) return { stage: 'no sync button' };
    sync.click();
    await wait(1200);
    const bring = Array.from(document.querySelectorAll('.sync-modal button'))
      .find(b => (b.textContent || '').includes('Bring in changes'));
    if (!bring) return { stage: 'no bring button' };
    bring.click();
    await wait(6000);

    const card = document.querySelector('.cf-card');
    const said = document.querySelector('.sync-modal .error')?.textContent
      ?? document.querySelector('.sync-ok')?.textContent ?? null;
    const sides = Array.from(document.querySelectorAll('.cf-side'));
    const modal = document.querySelector('.conflict-modal');
    const boxes = sides.map(s => s.getBoundingClientRect());
    return {
      stage: 'ok',
      said,
      panel: !!modal,
      cards: document.querySelectorAll('.cf-card').length,
      sides: sides.length,
      labels: sides.map(s => s.querySelector('.cf-who')?.textContent),
      mine: sides[0]?.textContent ?? null,
      theirs: sides[1]?.textContent ?? null,
      speakerShown: !!card?.querySelector('.cf-speaker'),
      widths: boxes.map(b => Math.round(b.width)),
      insideModal: modal ? boxes.every(b => b.right <= modal.getBoundingClientRect().right + 1) : null,
      applyLabel: Array.from(document.querySelectorAll('.conflict-modal .actions-row button'))
        .find(b => b.classList.contains('primary'))?.textContent ?? null,
      applyDisabled: Array.from(document.querySelectorAll('.conflict-modal .actions-row button'))
        .find(b => b.classList.contains('primary'))?.disabled ?? null,
      counter: document.querySelector('.cf-count')?.textContent ?? null
    };
  })()`)

  check('a clash opens the choosing panel', clashAsked.panel === true,
    String(clashAsked.said ?? JSON.stringify(clashAsked).slice(0, 260)))
  check('with one line to settle', clashAsked.cards === 1, String(clashAsked.cards))
  check('showing both readings', clashAsked.sides === 2, String(clashAsked.sides))
  check('labelled yours and theirs',
    JSON.stringify(clashAsked.labels) === JSON.stringify(['Yours', 'Theirs']),
    JSON.stringify(clashAsked.labels))
  check('yours is the edit made here', /My take/.test(clashAsked.mine ?? ''), String(clashAsked.mine))
  check('theirs is what arrived', /Their take/.test(clashAsked.theirs ?? ''), String(clashAsked.theirs))
  check('the speaker is named rather than the syntax shown',
    clashAsked.speakerShown === true, String(clashAsked.speakerShown))
  // Geometry: a choice you cannot see is not a choice.
  check('both sides have real width',
    (clashAsked.widths ?? []).every(w => w > 200), JSON.stringify(clashAsked.widths))
  check('and stay inside the panel', clashAsked.insideModal === true, String(clashAsked.insideModal))
  check('nothing can be applied until it is answered',
    clashAsked.applyDisabled === true, String(clashAsked.applyDisabled))
  check('and it says how many are left', /0 of 1 settled/.test(clashAsked.counter ?? ''),
    String(clashAsked.counter))

  const clashShots = path.join(os.tmpdir(), 'rpw-shots')
  await fs.mkdir(clashShots, { recursive: true })
  await shoot(web.webContents, 'conflict.png')
  console.log('  screenshot: ' + path.join(clashShots, 'conflict.png'))

  const clashAnswered = await webJs(`(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms * ${PACE}));
    document.querySelectorAll('.cf-side')[0].click();
    await wait(300);
    const apply = Array.from(document.querySelectorAll('.conflict-modal .actions-row button'))
      .find(b => b.classList.contains('primary'));
    const wasEnabled = !apply.disabled;
    apply.click();
    await wait(8000);
    return {
      wasEnabled,
      gone: !document.querySelector('.conflict-modal'),
      said: document.querySelector('.sync-ok')?.textContent
        ?? document.querySelector('.sync-modal .error')?.textContent ?? null
    };
  })()`)

  check('choosing a side enables bringing it in', clashAnswered.wasEnabled === true,
    String(clashAnswered.wasEnabled))
  check('and the panel closes once answered', clashAnswered.gone === true, String(clashAnswered.gone))
  check('reporting what was kept', /kept 1/.test(clashAnswered.said ?? ''), String(clashAnswered.said))

  const clashSettled = await fs.readFile(clashScript, 'utf8')
  check('the chosen wording is in the file', clashSettled.includes('My take:'),
    clashSettled.slice(0, 80))
  check('the wording not chosen is not', !clashSettled.includes('Their take:'),
    clashSettled.slice(0, 80))
  check('and no merge markers reached the script',
    !clashSettled.includes('<' + '<<<<<<'), clashSettled.slice(0, 120))

  // A proofreader's push being refused is the ordinary case, not the odd one,
  // so the panel has to read well when it happens -- and the link it offers
  // has to be a real, clickable thing rather than a string in the DOM.
  const bareRepo = path.join(syncBase, 'remote.git')
  const hook = path.join(bareRepo, 'hooks', 'pre-receive')
  const NL = String.fromCharCode(10)
  await fs.writeFile(hook,
    '#!/bin/sh' + NL +
    'while read old new ref; do' + NL +
    '  case "$ref" in' + NL +
    '    refs/heads/main)' + NL +
    '      echo "GitLab: You are not allowed to push code to protected branches." >&2' + NL +
    '      exit 1;;' + NL +
    '  esac' + NL +
    'done' + NL +
    'if [ "${GIT_PUSH_OPTION_COUNT:-0}" -gt 0 ]; then' + NL +
    '  echo "View merge request for the branch:" >&2' + NL +
    '  echo "  https://gitlab.example.com/tcfm/game/-/merge_requests/12" >&2' + NL +
    'fi' + NL +
    'exit 0' + NL, { mode: 0o755 })
  await gitRun(bareRepo, ['config', 'receive.advertisePushOptions', 'true'])

  await fs.writeFile(path.join(root, 'game', 'scripts', 'proofread_pass.rpy'),
    'label proofread_pass:' + NL)

  const refused = await webJs(`(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms * ${PACE}));
    const sync = Array.from(document.querySelectorAll('.mode-switch button'))
      .find(b => b.textContent === 'Sync');
    if (!sync) return { stage: 'no sync button' };
    sync.click();
    await wait(1500);
    const boxes = Array.from(document.querySelectorAll('.sg-files input[type=checkbox]'));
    for (const b of boxes) if (!b.checked) b.click();
    const input = document.querySelector('.sync-modal .field input');
    if (!input) return { stage: 'no message field' };
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      .call(input, 'A pass over chapter nine');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await wait(200);
    Array.from(document.querySelectorAll('.sync-modal .actions-row button'))
      .find(b => b.classList.contains('primary')).click();
    await wait(8000);

    const link = document.querySelector('.sync-link');
    const box = link?.getBoundingClientRect();
    const panel = document.querySelector('.sync-modal')?.getBoundingClientRect();
    return {
      stage: 'ok',
      good: !!document.querySelector('.sync-ok'),
      text: document.querySelector('.sync-ok')?.textContent
        ?? document.querySelector('.sync-modal .error')?.textContent ?? null,
      href: link?.getAttribute('href') ?? null,
      label: link?.textContent ?? null,
      target: link?.getAttribute('target') ?? null,
      rel: link?.getAttribute('rel') ?? null,
      width: box ? Math.round(box.width) : null,
      height: box ? Math.round(box.height) : null,
      inside: box && panel ? box.right <= panel.right + 1 && box.bottom <= panel.bottom + 1 : null,
      badge: document.querySelector('.sb-count')?.textContent ?? null,
      note: document.querySelector('.sb-review')?.textContent ?? null,
      buttons: Array.from(document.querySelectorAll('.sync-modal .actions-row button'))
        .map(b => b.textContent)
    };
  })()`)

  check('a refused push is reported as a merge request going up',
    refused.good === true && /for review/.test(refused.text ?? ''),
    JSON.stringify(refused).slice(0, 300))
  check('and names the branch the work went to',
    /proposal\/[a-z0-9-]+-to-main/.test(refused.text ?? ''), String(refused.text))
  check('the merge request is offered as a link',
    refused.href === 'https://gitlab.example.com/tcfm/game/-/merge_requests/12',
    String(refused.href))
  check('that opens away from the app, without handing it the opener',
    refused.target === '_blank' && (refused.rel ?? '').includes('noopener'),
    refused.target + ' / ' + refused.rel)
  // Geometry, because a link with no box is a link nobody can press.
  check('and is a thing on the screen, not just in the DOM',
    (refused.width ?? 0) > 40 && (refused.height ?? 0) > 8,
    refused.width + 'x' + refused.height)
  check('sitting inside the panel', refused.inside === true, String(refused.inside))

  // Once the work is in a review, the panel must stop calling it unsent and
  // stop offering the button that would only push it again.
  check('the panel now calls the work reviewed rather than unsent',
    /up for review/.test(refused.badge ?? '') && !/to send/.test(refused.badge ?? ''),
    String(refused.badge))
  check('and says where it is waiting',
    /proposal\/[a-z0-9-]+-to-main/.test(refused.note ?? ''), String(refused.note))
  check('the send button is gone, having nothing left to do',
    !(refused.buttons ?? []).some(b => /^Send \d+ waiting/.test(b ?? '')),
    JSON.stringify(refused.buttons))

  await shoot(web.webContents, 'refused-push.png')

  // The next commits in this run must not be turned into proposals too.
  await fs.rm(hook, { force: true })
  await webJs(`(() => {
    const close = Array.from(document.querySelectorAll('.sync-modal .actions-row button'))
      .find(b => b.textContent === 'Close');
    if (close) close.click();
    return true;
  })()`)

  // At phone size the three-column layout has to give way to one pane and a
  // bar of tabs, with nothing spilling off the side.
  web.setContentSize(390, 844)
  await sleep(1200)
  const onAPhone = await webJs(`(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms * ${PACE}));
    const visible = (sel) => {
      const el = document.querySelector(sel);
      return !!el && getComputedStyle(el).display !== 'none';
    };
    const panes = () => ['.sidebar', '.main', '.refpanel'].filter(visible);

    const start = {
      nav: !!document.querySelector('.phone-nav'),
      tabs: Array.from(document.querySelectorAll('.pn-label')).map(e => e.textContent),
      panes: panes(),
      overflow: document.body.scrollWidth - window.innerWidth,
      topRowExtras: Array.from(document.querySelectorAll('.mode-switch .ref-toggle'))
        .filter(b => getComputedStyle(b).display !== 'none').length,
      hint: visible('.wt-hint'),
      toolbar: visible('.writer-toolbar')
    };

    document.querySelectorAll('.pn-tab')[0].click();
    await wait(700);
    const outline = panes();

    document.querySelectorAll('.pn-tab')[2].click();
    await wait(900);
    const notes = panes();

    // Opening a beat should take you to the script, not leave you in the list.
    document.querySelectorAll('.pn-tab')[0].click();
    await wait(700);
    document.querySelector('.beat-row')?.click();
    await wait(2000);
    const afterBeat = panes();

    const navBox = document.querySelector('.phone-nav')?.getBoundingClientRect();
    const tapTarget = document.querySelector('.pn-tab')?.getBoundingClientRect();

    return { start, outline, notes, afterBeat,
      navBottom: navBox ? Math.round(navBox.bottom) : null,
      viewport: window.innerHeight,
      tapHeight: tapTarget ? Math.round(tapTarget.height) : null };
  })()`)

  check('a phone gets a bar of tabs', onAPhone.start?.nav === true, JSON.stringify(onAPhone.start))
  check('with the panes named',
    JSON.stringify(onAPhone.start?.tabs) === '["Outline","Script","Notes","Sync"]',
    JSON.stringify(onAPhone.start?.tabs))
  check('only one pane is on screen at a time',
    onAPhone.start?.panes.length === 1 && onAPhone.outline?.length === 1 &&
    onAPhone.notes?.length === 1,
    JSON.stringify([onAPhone.start?.panes, onAPhone.outline, onAPhone.notes]))
  check('each tab shows the pane it names',
    onAPhone.outline?.[0] === '.sidebar' && onAPhone.notes?.[0] === '.refpanel',
    JSON.stringify([onAPhone.outline, onAPhone.notes]))
  check('opening a beat moves to the script',
    onAPhone.afterBeat?.[0] === '.main', JSON.stringify(onAPhone.afterBeat))
  check('nothing spills off the side', onAPhone.start?.overflow === 0,
    String(onAPhone.start?.overflow))
  check('the top row drops what the bottom bar already offers',
    onAPhone.start?.topRowExtras === 0, String(onAPhone.start?.topRowExtras))
  check('keyboard shortcuts are not advertised to a touchscreen',
    onAPhone.start?.hint === false, String(onAPhone.start?.hint))
  check('and the desktop-only toolbar is gone entirely',
    onAPhone.start?.toolbar === false, String(onAPhone.start?.toolbar))
  check('the bar sits at the bottom of the viewport',
    Math.abs((onAPhone.navBottom ?? 0) - (onAPhone.viewport ?? 0)) <= 1,
    onAPhone.navBottom + ' vs ' + onAPhone.viewport)
  check('its targets are big enough for a thumb', (onAPhone.tapHeight ?? 0) >= 40,
    String(onAPhone.tapHeight))

  // A folder path on the server's disk is not the reader's to see: they did
  // not choose it, cannot open it, and it describes a machine they are not at.
  const noServerPaths = await webJs(
    '(() => {' +
    '  const bs = String.fromCharCode(92);' +
    '  const text = document.body.innerText;' +
    '  return {' +
    '    statusbar: document.querySelector(".statusbar")?.textContent ?? "",' +
    '    leaksDrive: text.indexOf("C:" + bs) !== -1,' +
    '    leaksUnix: text.indexOf("/srv/") !== -1 || text.indexOf("/home/") !== -1' +
    '  };' +
    '})()'
  )
  check('no filesystem path from the server is on screen',
    noServerPaths.leaksDrive === false && noServerPaths.leaksUnix === false,
    JSON.stringify(noServerPaths))
  // Changing a line's element was reachable only by pressing Tab, which a
  // phone does not have. This is that capability, by name.
  const elements = await webJs(`(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms * ${PACE}));
    document.querySelectorAll('.pn-tab')[1].click();
    await wait(900);
    const w = Array.from(document.querySelectorAll('.mode-switch button'))
      .find(b => b.textContent === 'Writer');
    if (w) { w.click(); await wait(1500); }

    const line = document.querySelector('.blk-dialogue .blk-text .blk-view');
    if (!line) return { stage: 'no dialogue line' };
    line.click();
    await wait(700);

    const names = Array.from(document.querySelectorAll('.fmt-kind')).map(b => b.textContent);
    const active = Array.from(document.querySelectorAll('.fmt-kind.on')).map(b => b.textContent);
    const height = document.querySelector('.fmt-kind')?.getBoundingClientRect().height ?? 0;
    const action = Array.from(document.querySelectorAll('.fmt-kind'))
      .find(b => b.textContent === 'Action');
    if (!action) return { stage: 'no element picker', names };

    // mousedown, because that is what keeps the textarea's selection alive.
    action.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    await wait(1200);

    return {
      stage: 'ok', names, active, height: Math.round(height),
      blocks: document.querySelectorAll('.blk-action').length
    };
  })()`)

  check('a line offers its element types by name', elements.stage === 'ok',
    JSON.stringify(elements))
  // Choice is not among them, and deliberately so: one option needs a `menu:`
  // around it, and nothing here could say where that menu ought to end.
  check('the two it can make are listed',
    JSON.stringify(elements.names) === '["Dialogue","Action"]',
    JSON.stringify(elements.names))
  check('the current one is marked',
    JSON.stringify(elements.active) === '["Dialogue"]', JSON.stringify(elements.active))
  check('they are big enough to tap', (elements.height ?? 0) >= 34, String(elements.height))
  check('choosing one changes the line', (elements.blocks ?? 0) > 0, String(elements.blocks))

  check('the status bar names something useful instead',
    (noServerPaths.statusbar ?? '').length > 0 &&
    noServerPaths.statusbar.indexOf('C:') === -1,
    String(noServerPaths.statusbar))

  web.destroy()
  await running.close()
  await fs.rm(syncBase, { recursive: true, force: true })
  // The settings folder is deliberately left behind. Chromium still has files
  // open in it while the app is running, so deleting it here fails, and the
  // temp directory it lives in is the operating system's to clear.
  await fs.rm(path.join(root, '.git'), { recursive: true, force: true })
  await fs.rm(serverData, { recursive: true, force: true })

  console.log('\n[plot board]')
  // A second episode to move beats into.
  await js(`window.api.createEpisode({
    renpyRoot: ${JSON.stringify(root)}, mode: 'new', name: 'Episode Draft'
  })`)
  await win.webContents.reload()
  await sleep(1400)
  await js(`document.querySelector('.project-item')?.click()`)
  await sleep(1500)

  const board = await js(`(async () => {
    Array.from(document.querySelectorAll('button')).find(b => b.textContent === 'Plot').click();
    await new Promise(r => setTimeout(r, 700));
    const cols = Array.from(document.querySelectorAll('.plot-col'));
    return {
      present: !!document.querySelector('.plot'),
      columns: cols.length,
      titles: cols.map(c => c.querySelector('.plot-title')?.textContent),
      cards: cols.map(c => c.querySelectorAll('.plot-card').length),
      statuses: cols.map(c => c.querySelector('.plot-status')?.textContent)
    };
  })()`)
  check('the plot board opens', board.present === true)
  check('every episode gets a column', board.columns === 3, String(board.columns) + ' ' + JSON.stringify(board.titles))
  check('beats appear as cards', board.cards[0] === 9, JSON.stringify(board.cards))
  check('episodes start in the game', board.statuses.every(s => s === 'In game'),
    JSON.stringify(board.statuses))

  console.log('\n[beats: adding, noting, removing]')
  {
    const outlineFile = path.join(root, '.renpywriter', 'outline.json')

    const added = await js(`(async () => {
      const wait = (ms) => new Promise(r => setTimeout(r, ms * ${PACE}));
      Array.from(document.querySelectorAll('.mode-switch button'))
        .find(b => b.textContent === 'Plot')?.click();
      await wait(700);

      const before = document.querySelectorAll('.plot-card').length;
      const titlesBefore = Array.from(document.querySelectorAll('.pc-title'))
        .map(e => e.textContent);

      const open = document.querySelector('.plot-add-open');
      if (!open) return { stage: 'no add control' };
      open.click();
      await wait(250);
      const input = document.querySelector('.plot-add input');
      if (!input) return { stage: 'no field' };
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
        .call(input, 'they_find_the_letter');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await wait(150);
      document.querySelector('.plot-add button.primary').click();
      await wait(900);

      const titles = Array.from(document.querySelectorAll('.pc-title')).map(e => e.textContent);
      return {
        stage: 'ok', before, after: document.querySelectorAll('.plot-card').length,
        titles, titlesBefore,
        error: document.querySelector('.error')?.textContent ?? null
      };
    })()`)

    check('a beat can be added from the plot board', added.stage === 'ok',
      JSON.stringify(added).slice(0, 160))
    check('and appears as a card', added.after === added.before + 1,
      `${added.before} -> ${added.after} | ${added.error ?? 'no error shown'}`)
    check('shown without its underscores',
      (added.titles ?? []).includes('THEY FIND THE LETTER'),
      JSON.stringify((added.titles ?? []).slice(-3)))
    check('and the ones from the script read the same way',
      (added.titlesBefore ?? []).every(t => !t.includes('_')),
      JSON.stringify((added.titlesBefore ?? []).slice(0, 3)))

    const outlineAfterAdd = JSON.parse(await fs.readFile(outlineFile, 'utf8'))
    const planned = outlineAfterAdd.beats.find((b) => b.title === 'THEY_FIND_THE_LETTER')
    check('it reached the outline file', !!planned, JSON.stringify(outlineAfterAdd.beats.length))
    check('the name typed in lower case becomes an upper-case label',
      planned?.label === 'THEY_FIND_THE_LETTER', JSON.stringify(planned))

    // A note on the beat, which is the point of planning one before writing.
    const noted = await js(`(async () => {
      const wait = (ms) => new Promise(r => setTimeout(r, ms * ${PACE}));
      const card = Array.from(document.querySelectorAll('.plot-card'))
        .find(c => c.querySelector('.pc-title')?.textContent === 'THEY FIND THE LETTER');
      if (!card) return { stage: 'no card' };
      card.querySelector('.pc-act').click();
      await wait(400);
      const box = document.querySelector('.beat-modal textarea');
      if (!box) return { stage: 'no beat window' };
      // The window says where the scene lives, which is the thing the card
      // has no room for.
      const where = document.querySelector('.beat-modal .bm-where')?.textContent ?? '';
      Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
        .call(box, 'She reads it twice and says nothing, and then she reads it a third time.');
      box.dispatchEvent(new Event('input', { bubbles: true }));
      await wait(150);
      Array.from(document.querySelectorAll('.beat-modal .actions-row button'))
        .find(b => b.textContent === 'Save').click();
      await wait(1000);
      const again = Array.from(document.querySelectorAll('.plot-card'))
        .find(c => c.querySelector('.pc-title')?.textContent === 'THEY FIND THE LETTER');
      const note = again?.querySelector('.pc-note');
      return {
        stage: 'ok', where,
        shown: note?.textContent ?? null,
        // Clamped to a couple of lines on the card; the whole thing is in
        // the title, and in the window.
        clamped: note ? note.scrollHeight > note.clientHeight + 1 : null,
        full: note?.getAttribute('title') ?? null
      };
    })()`)

    check('a note can be put on a beat', noted.stage === 'ok', JSON.stringify(noted))
    check('and shows on the card',
      (noted.shown ?? '').includes('reads it twice'), String(noted.shown))
    check('the window says where the scene lives',
      /THEY_FIND_THE_LETTER/.test(noted.where ?? '') && /chapter_/.test(noted.where ?? ''),
      String(noted.where))
    check('the card keeps the whole note within reach',
      (noted.full ?? '').includes('a third time'), String(noted.full))
    const outlineAfterNote = JSON.parse(await fs.readFile(outlineFile, 'utf8'))
    check('and is kept with the outline, not the script',
      (outlineAfterNote.beats.find((b) => b.title === 'THEY_FIND_THE_LETTER')?.description ?? '')
        .includes('reads it twice'),
      JSON.stringify(outlineAfterNote.beats.find((b) => b.title === 'THEY_FIND_THE_LETTER')))

    const scriptStillThere = await fs.readFile(
      path.join(root, 'game', 'scripts', 'chapter_2.rpy'), 'utf8')
    const plannedBody = (scriptStillThere.split('label THEY_FIND_THE_LETTER:')[1] ?? '').trim()
    check("the label is in the script, so it can be opened and typed into",
      scriptStillThere.includes('label THEY_FIND_THE_LETTER:'),
      scriptStillThere.slice(-120))
    check('with a body, so the game still loads',
      plannedBody.startsWith('pass'), JSON.stringify(plannedBody.slice(0, 40)))

    const renamed = await js(`(async () => {
      const wait = (ms) => new Promise(r => setTimeout(r, ms * ${PACE}));
      const card = Array.from(document.querySelectorAll('.plot-card'))
        .find(c => c.querySelector('.pc-title')?.textContent === 'THEY FIND THE LETTER');
      if (!card) return { stage: 'no card' };
      card.click();
      await wait(400);
      const name = document.querySelector('.beat-modal .field input');
      if (!name) return { stage: 'no name field' };
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
        .call(name, 'The letter on the table');
      name.dispatchEvent(new Event('input', { bubbles: true }));
      await wait(150);
      Array.from(document.querySelectorAll('.beat-modal .actions-row button'))
        .find(b => b.textContent === 'Save').click();
      await wait(1000);
      const titles = Array.from(document.querySelectorAll('.pc-title')).map(e => e.textContent);
      const card2 = Array.from(document.querySelectorAll('.plot-card'))
        .find(c => c.getAttribute('data-label') === 'THEY_FIND_THE_LETTER');
      return { stage: 'ok', titles, stillLabelled: !!card2 };
    })()`)

    check('a beat can be renamed from its window', renamed.stage === 'ok',
      JSON.stringify(renamed).slice(0, 160))
    check('and the card takes the new name',
      (renamed.titles ?? []).includes('THE LETTER ON THE TABLE'),
      JSON.stringify((renamed.titles ?? []).slice(-3)))
    check('while the label in the script is left alone',
      renamed.stillLabelled === true, String(renamed.stillLabelled))

    const outlineAfterRename = JSON.parse(await fs.readFile(outlineFile, 'utf8'))
    check('the new name is kept with the outline',
      outlineAfterRename.beats.some((b) => b.title === 'The letter on the table'),
      JSON.stringify(outlineAfterRename.beats.map((b) => b.title).slice(-3)))

    // Removing: offered for a beat nobody has written, refused for one in the
    // script, because a card is not a reason to delete a scene.
    const removal = await js(`(async () => {
      const wait = (ms) => new Promise(r => setTimeout(r, ms * ${PACE}));
      const cards = Array.from(document.querySelectorAll('.plot-card'));
      const written = cards.find(c => !c.textContent.includes('nothing written yet'));
      const planned = cards.find(c =>
        c.querySelector('.pc-title')?.textContent === 'THE LETTER ON THE TABLE');
      const writtenHasRemove = !!written?.querySelector('.pc-act.danger');
      planned.querySelector('.pc-act.danger').click();
      await wait(900);
      return {
        stage: 'ok', writtenHasRemove,
        left: Array.from(document.querySelectorAll('.pc-title')).map(e => e.textContent),
        error: document.querySelector('.error')?.textContent ?? null
      };
    })()`)

    check('a written beat offers removal too', removal.writtenHasRemove === true,
      String(removal.writtenHasRemove))
    check('an empty one can be removed',
      !(removal.left ?? []).includes('THE LETTER ON THE TABLE'),
      JSON.stringify(removal.left) + ' | ' + (removal.error ?? 'no error'))
    const outlineAfterRemove = JSON.parse(await fs.readFile(outlineFile, 'utf8'))
    check('and it left the outline file',
      !outlineAfterRemove.beats.some((b) => b.title === 'THEY_FIND_THE_LETTER'),
      String(outlineAfterRemove.beats.length))
  }

  console.log('\n[moving a beat to another episode]')
  const moved = await js(`(async () => {
    const before9 = await window.api.readEpisode(${JSON.stringify(root)}, 'chapter_2.rpy');
    const before7 = await window.api.readEpisode(${JSON.stringify(root)}, 'chapter_1.rpy');

    const cols = Array.from(document.querySelectorAll('.plot-col'));
    const source = cols.find(c => c.querySelector('.plot-file')?.textContent === 'chapter_2.rpy');
    const target = cols.find(c => c.querySelector('.plot-file')?.textContent === 'chapter_1.rpy');
    const card = source.querySelectorAll('.plot-card')[2];
    const label = card.getAttribute('data-label');

    const dt = new DataTransfer();
    card.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
    await new Promise(r => setTimeout(r, 150));
    const zone = target.querySelector('.plot-cards');
    zone.dispatchEvent(new DragEvent('dragover', { bubbles: true, dataTransfer: dt }));
    await new Promise(r => setTimeout(r, 150));
    zone.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: dt }));

    for (let i = 0; i < 40; i++) {
      await new Promise(r => setTimeout(r, 200));
      if (!document.querySelector('.plot-busy')) break;
    }
    await new Promise(r => setTimeout(r, 600));

    const after9 = await window.api.readEpisode(${JSON.stringify(root)}, 'chapter_2.rpy');
    const after7 = await window.api.readEpisode(${JSON.stringify(root)}, 'chapter_1.rpy');
    const cols2 = Array.from(document.querySelectorAll('.plot-col'));
    return {
      label,
      leftSource: before9.indexOf('label ' + label + ':') !== -1 &&
                  after9.indexOf('label ' + label + ':') === -1,
      arrived: before7.indexOf('label ' + label + ':') === -1 &&
               after7.indexOf('label ' + label + ':') !== -1,
      sourceShrank: after9.length < before9.length,
      targetGrew: after7.length > before7.length,
      cards: cols2.map(c => c.querySelectorAll('.plot-card').length),
      note: document.querySelector('.plot-note')?.textContent ?? null
    };
  })()`)
  check('the beat left its source file', moved.leftSource === true, String(moved.label))
  check('the beat arrived in the target file', moved.arrived === true)
  check('the source file shrank', moved.sourceShrank === true)
  check('the target file grew', moved.targetGrew === true)
  check('the board reflects the move', moved.cards[0] === 8, JSON.stringify(moved.cards))
  check('the writer is told what was rewritten',
    typeof moved.note === 'string' && moved.note.length > 0, String(moved.note))

  console.log('\n[draft episodes stay out of the game folder]')
  const drafted = await js(`(async () => {
    const cols = Array.from(document.querySelectorAll('.plot-col'));
    const col = cols.find(c => c.querySelector('.plot-title')?.textContent === 'Episode Draft');
    const file = col.querySelector('.plot-file').textContent;
    col.querySelector('.plot-status').click();
    await new Promise(r => setTimeout(r, 900));
    const cols2 = Array.from(document.querySelectorAll('.plot-col'));
    const col2 = cols2.find(c => c.querySelector('.plot-title')?.textContent === 'Episode Draft');
    return {
      file,
      status: col2.querySelector('.plot-status')?.textContent ?? null,
      stillReadable: (await window.api.readEpisode(${JSON.stringify(root)}, file)).length > 0
    };
  })()`)
  check('an episode can be marked a draft', drafted.status === 'Draft', String(drafted.status))
  check('a draft is still readable in the app', drafted.stillReadable === true)

  if (drafted.file) {
    const gameCopy = path.join(root, 'game', 'scripts', drafted.file)
    const draftCopy = path.join(root, '.renpywriter', 'drafts', drafted.file)
    const exists = async (p) => { try { await fs.access(p); return true } catch { return false } }
    check('the draft file left the game folder', (await exists(gameCopy)) === false, gameCopy)
    check('it now lives in the sidecar drafts folder', (await exists(draftCopy)) === true, draftCopy)
  }

  const released = await js(`(async () => {
    const cols = Array.from(document.querySelectorAll('.plot-col'));
    const col = cols.find(c => c.querySelector('.plot-title')?.textContent === 'Episode Draft');
    col.querySelector('.plot-status').click();
    await new Promise(r => setTimeout(r, 900));
    const cols2 = Array.from(document.querySelectorAll('.plot-col'));
    const col2 = cols2.find(c => c.querySelector('.plot-title')?.textContent === 'Episode Draft');
    return { status: col2.querySelector('.plot-status')?.textContent ?? null };
  })()`)
  check('it can be released again', released.status === 'In game', String(released.status))
  if (drafted.file) {
    const gameCopy = path.join(root, 'game', 'scripts', drafted.file)
    const draftCopy = path.join(root, '.renpywriter', 'drafts', drafted.file)
    const exists = async (p) => { try { await fs.access(p); return true } catch { return false } }
    check('releasing moves the file back', (await exists(gameCopy)) === true, gameCopy)
    check('and removes the draft copy', (await exists(draftCopy)) === false, draftCopy)
  }

  console.log('\n[reordering episodes]')
  const reordered = await js(`(async () => {
    const before = Array.from(document.querySelectorAll('.plot-title')).map(t => t.textContent);
    const cols = Array.from(document.querySelectorAll('.plot-col'));
    const dt = new DataTransfer();
    const last = cols[cols.length - 1];
    last.querySelector('.rl-grip').dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
    await new Promise(r => setTimeout(r, 150));
    cols[0].dispatchEvent(new DragEvent('dragover', { bubbles: true, dataTransfer: dt }));
    cols[0].dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: dt }));
    await new Promise(r => setTimeout(r, 900));
    const after = Array.from(document.querySelectorAll('.plot-title')).map(t => t.textContent);
    return { before, after };
  })()`)
  check('dragging an episode reorders the board',
    reordered.after[0] === reordered.before[reordered.before.length - 1],
    JSON.stringify(reordered.before) + ' -> ' + JSON.stringify(reordered.after))

  console.log('\n[character profiles survive closing and reopening]')
  {
    // The reference files save on a debounce, so a write lands more than a
    // second after the edit that scheduled it. Close a project and open one in
    // that window and the write arrives holding the wrong thing -- which
    // emptied the character profiles of a real project, silently, leaving the
    // app looking like it had simply forgotten them.
    const profileFile = path.join(root, '.renpywriter', 'characters.json')
    const before = JSON.parse(await fs.readFile(profileFile, 'utf8'))

    const cycled = await js(`(async () => {
      const wait = (ms) => new Promise(r => setTimeout(r, ms * ${PACE}));
      const pick = (sel, text) => Array.from(document.querySelectorAll(sel))
        .find(e => (e.textContent || '').trim() === text);

      document.querySelector('.switcher-trigger')?.click();
      await wait(250);
      const close = pick('.popover-item .pi-name', 'Close project');
      if (!close) return { stage: 'no close control' };
      close.closest('button').click();
      await wait(300);
      const atGate = !!document.querySelector('.gate-card');

      // Straight back in, which is where the stale write used to land.
      document.querySelector('.project-item')?.click();
      await wait(600);
      return { stage: 'ok', atGate, reopened: !!document.querySelector('.switcher-trigger') };
    })()`)

    // Longer than the autosave, so any stray write has arrived by now.
    await sleep(2500)

    const after = JSON.parse(await fs.readFile(profileFile, 'utf8'))
    check('the app was driven through close and reopen', cycled.stage === 'ok',
      JSON.stringify(cycled))
    check('it went back to the project list', cycled.atGate === true, String(cycled.atGate))
    check('and opened the project again', cycled.reopened === true, String(cycled.reopened))
    check('the profiles are still there',
      (after.characters ?? []).length === (before.characters ?? []).length &&
      (after.characters ?? []).length > 0,
      `${(before.characters ?? []).length} -> ${(after.characters ?? []).length}`)
    check('with everything written about them',
      JSON.stringify(after.characters) === JSON.stringify(before.characters),
      JSON.stringify(after.characters ?? []).slice(0, 120))
    check('and their order', JSON.stringify(after.characterOrder) ===
      JSON.stringify(before.characterOrder), JSON.stringify(after.characterOrder))
  }

  console.log('\n[nothing was lost]')
  // The plot test moved a beat between files, so per-file comparison is not
  // meaningful. What must hold is that no label vanished from the project.
  {
    const labelsOf = (text) =>
      text.split(String.fromCharCode(10))
        .map((l) => l.match(/^label\s+([A-Za-z_]\w*)\s*:/))
        .filter(Boolean)
        .map((m) => m[1])

    const files = ['chapter_2.rpy', 'chapter_1.rpy', 'script.rpy']
    const before = new Set()
    const after = new Set()
    for (const f of files) {
      const orig = await fs.readFile(
        path.join(SAMPLE, 'game', 'scripts', f), 'utf8')
      labelsOf(orig).forEach((l) => before.add(l))
      const now = await fs.readFile(path.join(root, 'game', 'scripts', f), 'utf8')
      labelsOf(now).forEach((l) => after.add(l))
    }
    const lost = [...before].filter((l) => !after.has(l))
    const gained = [...after].filter((l) => !before.has(l))
    check('every label still exists somewhere', lost.length === 0, lost.join(', '))
    check('no labels were invented', gained.length === 0, gained.join(', '))
    check('the project still has all its beats', after.size === before.size,
      before.size + ' -> ' + after.size)
  }

  for (const p of problems) check(p, false)

  console.log('\n[removing a written scene]')
  {
    const chapter = path.join(root, 'game', 'scripts', 'chapter_2.rpy')
    const before = await fs.readFile(chapter, 'utf8')

    const asked = await js(`(async () => {
      const wait = (ms) => new Promise(r => setTimeout(r, ms * ${PACE}));
      Array.from(document.querySelectorAll('.mode-switch button'))
        .find(b => b.textContent === 'Plot')?.click();
      await wait(800);

      // A scene nothing jumps to, so the removal is allowed.
      const cards = Array.from(document.querySelectorAll('.plot-card'));
      const card = cards.find(c => c.getAttribute('data-label') === 'ch2_kettle');
      if (!card) return { stage: 'no kettle card', labels: cards.map(c => c.getAttribute('data-label')) };
      card.querySelector('.pc-act.danger').click();
      await wait(900);

      const modal = document.querySelector('.remove-modal');
      if (!modal) return { stage: 'no confirmation' };
      return {
        stage: 'ok',
        heading: modal.querySelector('h2')?.textContent ?? null,
        body: modal.textContent ?? '',
        buttons: Array.from(modal.querySelectorAll('.actions-row button')).map(b => b.textContent)
      };
    })()`)

    check('removing a written scene asks first', asked.stage === 'ok',
      JSON.stringify(asked).slice(0, 200))
    check('and names the scene', /CH2 KETTLE/.test(asked.heading ?? ''), String(asked.heading))
    check('and says how much goes, and from where',
      /\d+ lines/.test(asked.body ?? '') && /chapter_2\.rpy/.test(asked.body ?? ''),
      String(asked.body).slice(0, 200))
    check('and offers a way out', (asked.buttons ?? []).includes('Keep it'),
      JSON.stringify(asked.buttons))

    const untouched = await fs.readFile(chapter, 'utf8')
    check('nothing is written while it is only asking', untouched === before,
      'the script changed before anybody agreed')

    const done = await js(`(async () => {
      const wait = (ms) => new Promise(r => setTimeout(r, ms * ${PACE}));
      Array.from(document.querySelectorAll('.remove-modal .actions-row button'))
        .find(b => b.textContent === 'Remove it').click();
      await wait(1500);
      return {
        gone: !document.querySelector('.remove-modal'),
        labels: Array.from(document.querySelectorAll('.plot-card'))
          .map(c => c.getAttribute('data-label'))
      };
    })()`)

    const after = await fs.readFile(chapter, 'utf8')
    check('agreeing closes the question', done.gone === true, String(done.gone))
    check('the label is gone from the script', !after.includes('label ch2_kettle:'),
      after.slice(0, 80))
    check('and its dialogue with it', !after.includes('beat 2.'), 'dialogue survived')
    check('the scenes around it are still there',
      after.includes('label ch2_arrival:') && (after.match(/^label /gm) ?? []).length >= 5,
      'what is left: ' + JSON.stringify(after.match(/^label \w+/gm)))
    check('no jump to the removed scene was invented',
      !after.includes('jump ch2_kettle'), 'a dangling jump was written')
    check('and the card is gone from the board',
      !(done.labels ?? []).includes('ch2_kettle'), JSON.stringify(done.labels))
    check('the file got shorter, not longer', after.length < before.length,
      `${before.length} -> ${after.length}`)
  }

  console.log('\n[scenes, from the writer]')
  {
    // A beat planned on the plot board opens in the writer as a heading with
    // nothing under it: the `pass` holding it open is a code line, and code
    // lines are hidden here. There was nothing to click and no line to press
    // Enter on, so a scene could be planned and then not written.
    const chapter = path.join(root, 'game', 'scripts', 'chapter_2.rpy')

    const opened = await js(`(async () => {${UNTIL}
      Array.from(document.querySelectorAll('.episode-row'))
        .find(e => e.textContent.includes('chapter_2'))?.click();
      await until(() => document.querySelector('.tab.active'));
      Array.from(document.querySelectorAll('.mode-switch button'))
        .find(b => b.textContent === 'Writer')?.click();
      await until(() => document.querySelector('.blk-label'));
      return { labels: Array.from(document.querySelectorAll('.blk-label-name')).map(e => e.textContent) };
    })()`)
    check('the writer is showing chapter 2', (opened.labels ?? []).includes('ch2_arrival'),
      JSON.stringify(opened.labels).slice(0, 120))

    // --- a new scene, named where a scene is named -----------------------
    const added = await js(`(async () => {${UNTIL}
      const labelOf = (name) => Array.from(document.querySelectorAll('.blk-label'))
        .find(el => el.querySelector('.blk-label-name')?.textContent === name);
      const row = labelOf('ch2_arrival');
      if (!row) return { stage: 'no label' };
      row.querySelector('.blk-label-more').click();
      await until(() => document.querySelector('.ctxmenu'));
      const offered = Array.from(document.querySelectorAll('.ctx-item')).map(b => b.textContent);
      Array.from(document.querySelectorAll('.ctx-item'))
        .find(b => b.textContent === 'New scene below').click();

      const input = await until(() => document.querySelector('.blk-label-input'));
      if (!input) return { stage: 'no name field', offered };
      // Named by typing over it, so the placeholder must be selected.
      const selected = input.selectionEnd - input.selectionStart === input.value.length;
      const placeholder = input.value;

      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
        .call(input, 'The letter on the table');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

      // Enter takes the name and puts the cursor on the first line.
      const cue = await until(() => document.querySelector('.blk-character-input'));
      return {
        stage: 'ok', offered, selected, placeholder,
        started: !!cue,
        focused: document.activeElement === cue,
        labels: Array.from(document.querySelectorAll('.blk-label-name')).map(e => e.textContent)
      };
    })()`)

    check('the scene menu offers what can be done with one', added.stage === 'ok',
      JSON.stringify(added).slice(0, 200))
    check('including a new scene and removing this one',
      (added.offered ?? []).includes('New scene below') &&
      (added.offered ?? []).includes('Remove scene'), JSON.stringify(added.offered))
    check('the placeholder name is selected, ready to be typed over',
      added.selected === true, String(added.placeholder))
    check('the new scene takes the name, upper-cased like the plot board writes them',
      (added.labels ?? []).includes('THE_LETTER_ON_THE_TABLE'),
      JSON.stringify((added.labels ?? []).slice(0, 4)))
    check('and Enter goes straight to writing it',
      added.started === true && added.focused === true,
      `started=${added.started} focused=${added.focused}`)

    // --- and the words go in ---------------------------------------------
    const written = await js(`(async () => {${UNTIL}
      const cue = document.querySelector('.blk-character-input');
      if (!cue) return { stage: 'no cue' };
      const set = (el, v) => {
        const proto = el instanceof HTMLTextAreaElement
          ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v);
        el.dispatchEvent(new Event('input', { bubbles: true }));
      };
      set(cue, 'ava');
      await wait(250);
      cue.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      const ta = await until(() => document.querySelector('.blk-input'));
      if (!ta) return { stage: 'no text field' };
      set(ta, 'She reads it twice and says nothing.');
      ta.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
      await wait(400);
      return { stage: 'ok' };
    })()`)
    check('a line can be typed into the new scene', written.stage === 'ok',
      JSON.stringify(written))

    // Past the autosave.
    await sleep(3000)
    const source = await fs.readFile(chapter, 'utf8')
    const beat = source.slice(source.indexOf('label THE_LETTER_ON_THE_TABLE:'))
      .split(/\r?\n/).slice(0, 4).join('\n')
    check('the scene reached the script', source.includes('label THE_LETTER_ON_THE_TABLE:'),
      'not in the file')
    check('with the line under it', /ava "She reads it twice and says nothing\."/.test(source),
      beat)
    check('and no placeholder left holding it open', !/pass/.test(beat), beat)
    check('while the scene it was added below is untouched',
      source.includes('label ch2_arrival:'), 'ch2_arrival went missing')

    // --- the outline hears about it --------------------------------------
    const inOutline = await js(`(async () => {${UNTIL}
      Array.from(document.querySelectorAll('.mode-switch button'))
        .find(b => b.textContent === 'Plot')?.click();
      const card = await until(() => Array.from(document.querySelectorAll('.plot-card'))
        .find(c => c.getAttribute('data-label') === 'THE_LETTER_ON_THE_TABLE'));
      return { there: !!card, title: card?.querySelector('.pc-title')?.textContent ?? null };
    })()`)
    check('the outline has the scene without being asked', inOutline.there === true,
      JSON.stringify(inOutline))
    check('under the name that was typed', inOutline.title === 'THE LETTER ON THE TABLE',
      String(inOutline.title))

    // --- a scene planned and not yet written ------------------------------
    // Reported rather than thrown: an exception in here leaves the harness
    // waiting on a promise that never settles, and the rest of the suite goes
    // with it.
    const planned = await js(`(async () => {${UNTIL}
      Array.from(document.querySelectorAll('.tab'))
        .find(t => t.textContent.indexOf('chapter_2') !== -1)?.click();
      await wait(400);
      Array.from(document.querySelectorAll('.mode-switch button'))
        .find(b => b.textContent === 'Writer')?.click();
      await until(() => document.querySelector('.blk-label'));

      const named = (name) => Array.from(document.querySelectorAll('.blk-label'))
        .find(el => el.querySelector('.blk-label-name')?.textContent === name);
      const row = await until(() => named('THE_LETTER_ON_THE_TABLE'));
      if (!row) {
        return { stage: 'no such scene',
                 showing: Array.from(document.querySelectorAll('.blk-label-name'))
                   .map(e => e.textContent).slice(0, 12) };
      }
      const more = row.querySelector('.blk-label-more');
      if (!more) return { stage: 'no menu button', row: row.className };
      more.click();
      const menu = await until(() => document.querySelector('.ctxmenu'));
      if (!menu) return { stage: 'menu never opened' };
      const item = Array.from(document.querySelectorAll('.ctx-item'))
        .find(b => b.textContent === 'New scene below');
      if (!item) {
        return { stage: 'no such item',
                 items: Array.from(document.querySelectorAll('.ctx-item')).map(b => b.textContent) };
      }
      item.click();

      const input = await until(() => document.querySelector('.blk-label-input'));
      if (!input) return { stage: 'no name field' };
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
        .call(input, 'What she does next');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      // Escape rather than Enter: named, and left for later.
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      input.blur();
      await wait(700);

      const heading = named('WHAT_SHE_DOES_NEXT');
      const invitation = heading?.nextElementSibling;
      return {
        stage: 'ok',
        named: !!heading,
        showing: Array.from(document.querySelectorAll('.blk-label-name'))
          .map(e => e.textContent).slice(0, 12),
        invited: invitation?.className ?? null,
        says: invitation?.textContent ?? null
      };
    })()`)

    check('a scene can be left planned rather than written', planned.named === true,
      JSON.stringify(planned).slice(0, 200))
    check('and says so where the words would be',
      (planned.invited ?? '').includes('blk-start'), String(planned.invited))
    check('in words that offer a way in',
      /start the scene/i.test(planned.says ?? ''), String(planned.says))

    await sleep(3000)
    const planning = await fs.readFile(chapter, 'utf8')
    const held = planning.slice(planning.indexOf('label WHAT_SHE_DOES_NEXT:'))
      .split(/\r?\n/).slice(0, 3).join('\n')
    check('and is held open in the script the same way the plot board holds one',
      /label WHAT_SHE_DOES_NEXT:\s*\n\s+pass/.test(planning), held)

    // The scene menu open over a scene with nothing in it, which is the pair
    // of things this section is about. Checks read the DOM, which has been
    // known to look perfect while the thing on screen was unreadable.
    const menuOpen = await js(`(async () => {${UNTIL}
      const heading = Array.from(document.querySelectorAll('.blk-label'))
        .find(el => el.querySelector('.blk-label-name')?.textContent === 'WHAT_SHE_DOES_NEXT');
      if (!heading) return { stage: 'no such scene' };
      heading.scrollIntoView({ block: 'center' });
      await wait(300);
      heading.querySelector('.blk-label-more').click();
      const menu = await until(() => document.querySelector('.ctxmenu'));
      return { stage: menu ? 'ok' : 'menu never opened' };
    })()`)
    check('the scene menu opens over the page', menuOpen.stage === 'ok', JSON.stringify(menuOpen))

    await shoot(win.webContents, 'writer-scenes.png')

    await js(`(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await new Promise(r => setTimeout(r, 300));
    })()`)

    const begun = await js(`(async () => {${UNTIL}
      const heading = Array.from(document.querySelectorAll('.blk-label'))
        .find(el => el.querySelector('.blk-label-name')?.textContent === 'WHAT_SHE_DOES_NEXT');
      if (!heading) return { stage: 'no such scene' };
      const invitation = heading.nextElementSibling;
      if (!invitation || invitation.className.indexOf('blk-start') === -1) {
        return { stage: 'nothing to click', invited: invitation?.className ?? null };
      }
      invitation.click();
      const cue = await until(() => document.querySelector('.blk-character-input'));
      return { stage: 'ok', started: !!cue, focused: document.activeElement === cue };
    })()`)
    check('clicking it starts the scene', begun.started === true && begun.focused === true,
      JSON.stringify(begun))

    // --- and a scene can go ------------------------------------------------
    const removed = await js(`(async () => {${UNTIL}
      document.activeElement?.blur();
      await wait(400);
      const row = Array.from(document.querySelectorAll('.blk-label'))
        .find(el => el.querySelector('.blk-label-name')?.textContent === 'WHAT_SHE_DOES_NEXT');
      if (!row) return { stage: 'gone already' };
      const more = row.querySelector('.blk-label-more');
      if (!more) return { stage: 'no menu button' };
      more.click();
      const menu = await until(() => document.querySelector('.ctxmenu'));
      if (!menu) return { stage: 'menu never opened' };
      const item = Array.from(document.querySelectorAll('.ctx-item'))
        .find(b => b.textContent === 'Remove scene');
      if (!item) {
        return { stage: 'no such item',
                 items: Array.from(document.querySelectorAll('.ctx-item')).map(b => b.textContent) };
      }
      item.click();

      const asked = await until(() => document.querySelector('.remove-modal'));
      if (!asked) return { stage: 'never asked' };
      const warning = asked.textContent ?? '';
      Array.from(document.querySelectorAll('.remove-modal .actions-row button'))
        .find(b => b.textContent === 'Remove it').click();
      await wait(2000);
      return {
        stage: 'ok', warning,
        labels: Array.from(document.querySelectorAll('.blk-label-name')).map(e => e.textContent)
      };
    })()`)

    check('removing a scene asks before it writes', removed.stage === 'ok',
      JSON.stringify(removed).slice(0, 200))
    check('and says what it will cost', /line/.test(removed.warning ?? ''),
      String(removed.warning).slice(0, 140))
    check('the scene left the writer', !(removed.labels ?? []).includes('WHAT_SHE_DOES_NEXT'),
      JSON.stringify(removed.labels ?? []).slice(0, 160))

    const afterRemoval = await fs.readFile(chapter, 'utf8')
    check('and the script', !afterRemoval.includes('WHAT_SHE_DOES_NEXT'), 'still in the file')
    check('while the scene before it stayed',
      afterRemoval.includes('label THE_LETTER_ON_THE_TABLE:'), 'took the wrong one')

    const outlineAfter = JSON.parse(
      await fs.readFile(path.join(root, '.renpywriter', 'outline.json'), 'utf8'))
    check('the outline lost it too, rather than keeping an unwritten ghost',
      !outlineAfter.beats.some((b) => b.title === 'WHAT_SHE_DOES_NEXT' ||
        b.label === 'WHAT_SHE_DOES_NEXT'),
      JSON.stringify(outlineAfter.beats.map((b) => b.title).slice(-4)))
  }

  console.log('\n[a character who is not in the script yet]')
  {
    // Somebody typed into the reference panel has no Character() definition,
    // so they cannot speak. Writing that definition by hand is the one bit of
    // Ren'Py the panel used to leave to the writer.
    const charactersFile = path.join(root, 'game', 'characters.rpy')
    await fs.rm(charactersFile, { force: true })

    const offered = await js(`(async () => {${UNTIL}
      const setVal = (el, v) => {
        Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(el, v);
        el.dispatchEvent(new Event('input', { bubbles: true }));
      };
      if (!document.querySelector('.refpanel')) {
        Array.from(document.querySelectorAll('button'))
          .find(b => b.textContent === 'Reference').click();
        await until(() => document.querySelector('.refpanel'));
      }
      Array.from(document.querySelectorAll('.ref-actions button'))
        .find(b => b.textContent === 'Add character').click();
      await until(() => document.querySelector('.modal .field input'));

      // Nothing typed yet. A nameless profile is fine; a nameless line in the
      // script is not.
      const primary = () => Array.from(document.querySelectorAll('.modal .actions-row button'))
        .find(b => b.textContent.indexOf('Create') === 0);
      const blockedWhileBlank = primary()?.disabled ?? null;

      setVal(document.querySelector('.modal .field input'), 'Mara Kowalski');
      await wait(200);

      // Nothing ticked in the variable list, so the offer is on the table.
      const offer = Array.from(document.querySelectorAll('.modal label.check'))
        .find(l => l.textContent.indexOf('script') !== -1);
      const ticked = offer?.querySelector('input')?.checked ?? null;
      const preview = document.querySelector('.modal .hint code')?.textContent ?? null;
      const label = Array.from(document.querySelectorAll('.modal .actions-row button'))
        .find(b => b.textContent.indexOf('Create') === 0)?.textContent ?? null;

      return { stage: 'ok', ticked, preview, label, blockedWhileBlank };
    })()`)

    // The dialog as it stands, offer and all. Checks read the DOM, which has
    // been known to look perfect while the thing on screen was unreadable.
    await shoot(win.webContents, 'define-character.png')

    const made = await js(`(async () => {${UNTIL}
      Array.from(document.querySelectorAll('.modal .actions-row button'))
        .find(b => b.textContent.indexOf('Create') === 0).click();
      await until(() => document.querySelector('.chareditor'));
      await wait(600);
      return {
        variables: Array.from(document.querySelectorAll('.ce-varlist li .cv-name'))
          .map(e => e.textContent),
        heading: document.querySelector('.ce-head h1')?.textContent ?? null
      };
    })()`)

    check('the offer is made for a character with no variables', offered.ticked === true,
      JSON.stringify(offered).slice(0, 200))
    check('and shows the exact line it will write',
      (offered.preview ?? '') === 'define mara_kowalski = Character("Mara Kowalski")',
      String(offered.preview))
    check('a nameless character cannot be written into the script',
      offered.blockedWhileBlank === true, String(offered.blockedWhileBlank))
    check('the button says what it is about to do',
      (offered.label ?? '').indexOf('define') !== -1, String(offered.label))

    const written = await fs.readFile(charactersFile, 'utf8')
    check('game/characters.rpy was created with the definition',
      written.includes('define mara_kowalski = Character("Mara Kowalski")'), written)

    // The point of doing it here rather than by hand: the cast on screen knows
    // about them straight away, with no reopening of the project.
    check('and the profile is holding the new variable',
      (made.variables ?? []).includes('mara_kowalski'), JSON.stringify(made.variables))
    check('under the name that was typed', made.heading === 'Mara Kowalski',
      String(made.heading))

    // Untick it, and nothing is written.
    const notesOnly = await js(`(async () => {${UNTIL}
      const setVal = (el, v) => {
        Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(el, v);
        el.dispatchEvent(new Event('input', { bubbles: true }));
      };
      Array.from(document.querySelectorAll('.ref-actions button'))
        .find(b => b.textContent === 'Add character').click();
      await until(() => document.querySelector('.modal .field input'));
      setVal(document.querySelector('.modal .field input'), 'Ivy Sole');
      await wait(200);

      const box = Array.from(document.querySelectorAll('.modal label.check'))
        .find(l => l.textContent.indexOf('script') !== -1)?.querySelector('input');
      box.click();
      await wait(250);
      const label = Array.from(document.querySelectorAll('.modal .actions-row button'))
        .find(b => b.textContent.indexOf('Create') === 0)?.textContent ?? null;

      Array.from(document.querySelectorAll('.modal .actions-row button'))
        .find(b => b.textContent.indexOf('Create') === 0).click();
      await until(() => (document.querySelector('.ce-head h1')?.textContent ?? '') === 'Ivy Sole');
      await wait(600);

      return {
        stage: 'ok', label,
        variables: Array.from(document.querySelectorAll('.ce-varlist li .cv-name'))
          .map(e => e.textContent)
      };
    })()`)

    check('the offer can be declined', (notesOnly.label ?? '').indexOf('notes-only') !== -1,
      String(notesOnly.label))
    check('and then nobody is written into the script',
      (notesOnly.variables ?? []).length === 0, JSON.stringify(notesOnly.variables))
    const still = await fs.readFile(charactersFile, 'utf8')
    check('the file gained nothing from the declined one',
      !still.includes('ivy_sole'), still)
    check('and the one before it is still there',
      still.includes('define mara_kowalski'), still)

    // Both profiles are kept, and only the defined one claims a variable.
    await sleep(1800)
    const saved = await js(`window.api.readReference(${JSON.stringify(root)})`)
    const mara = (saved.characters ?? []).find((c) => c.name === 'Mara Kowalski')
    const ivy = (saved.characters ?? []).find((c) => c.name === 'Ivy Sole')
    check('the written character is saved with their variable',
      JSON.stringify(mara?.varNames ?? []) === JSON.stringify(['mara_kowalski']),
      JSON.stringify(mara?.varNames))
    check('and the notes-only one with none',
      JSON.stringify(ivy?.varNames ?? []) === '[]', JSON.stringify(ivy?.varNames))

    // Leave the panel as it was found.
    await js(`(async () => {${UNTIL}
      if (document.querySelector('.refpanel')) {
        Array.from(document.querySelectorAll('button'))
          .find(b => b.textContent === 'Reference').click();
        await wait(400);
      }
    })()`)
    await fs.rm(charactersFile, { force: true })
  }

  console.log('\n[a deleted scene stays deleted]')
  {
    // With the file open in the editor, deleting a scene from the board has
    // to reach that editor too. Otherwise the tab keeps the text from before
    // and its autosave writes it back a second later -- and the scene comes
    // back, put there by a tab nobody touched.
    const chapter = path.join(root, 'game', 'scripts', 'chapter_2.rpy')

    const staged = await js(`(async () => {
      try {
      const wait = (ms) => new Promise(r => setTimeout(r, ms * ${PACE}));
      // Open the file in the writer, so there is a tab holding its text.
      Array.from(document.querySelectorAll('.episode-row'))
        .find(e => e.textContent.includes('chapter_2'))?.click();
      await wait(1200);

      Array.from(document.querySelectorAll('.mode-switch button'))
        .find(b => b.textContent === 'Plot')?.click();
      await wait(800);
      const cards = Array.from(document.querySelectorAll('.plot-card'));
      const target = cards.find(c => c.getAttribute('data-label') === 'ch2_yard');
      if (!target) return {
        stage: 'no card',
        labels: cards.map(c => c.getAttribute('data-label')),
        cols: document.querySelectorAll('.plot-col').length,
        modal: !!document.querySelector('.modal-backdrop')
      };

      target.querySelector('.pc-act.danger').click();
      await wait(700);
      const asked = !!document.querySelector('.remove-modal');
      const go = Array.from(document.querySelectorAll('.remove-modal .actions-row button'))
        .find(b => b.textContent === 'Remove it');
      if (asked && !go) {
        return { stage: 'refused', why: document.querySelector('.remove-modal')?.textContent };
      }
      if (go) go.click();
      await wait(1500);

      // Back to the editor that was holding this file. What it shows now is
      // the point: a tab still displaying the deleted scene is how somebody
      // concludes the deletion did not work.
      Array.from(document.querySelectorAll('.tab'))
        .find(t => t.textContent.indexOf('chapter_2') !== -1)?.click();
      await wait(500);
      Array.from(document.querySelectorAll('.mode-switch button'))
        .find(b => b.textContent === 'Code')?.click();
      await wait(900);
      const shown = document.querySelector('.cm-content')?.textContent
        ?? document.querySelector('.writer-page')?.textContent ?? '';
      return { stage: 'ok', asked, showsDeleted: shown.indexOf('ch2_yard') !== -1 };
      } catch (e) { return { stage: 'threw', why: String(e && e.message || e) }; }
    })()`)

    check('the scene was deleted with its file open', staged.stage === 'ok',
      JSON.stringify(staged).slice(0, 200))
    // Not a strong check: the code editor only renders the lines on screen,
    // so a label scrolled out of view is absent from the DOM whether or not
    // the tab was refreshed. Kept because it costs nothing and would catch
    // the blatant case.
    check('and the editor is not obviously showing it',
      staged.showsDeleted === false,
      'the open tab still displays the deleted scene')

    const straightAfter = await fs.readFile(chapter, 'utf8')
    check('it left the script', !straightAfter.includes('label ch2_yard:'),
      'still there immediately after')

    // Well past the autosave, which is when a stale tab would put it back.
    await sleep(3000)
    const later = await fs.readFile(chapter, 'utf8')
    check('and it is still gone once the editor has had its say',
      !later.includes('label ch2_yard:'),
      'the open tab wrote the deleted scene back')
    check('and nothing else came back with it', later === straightAfter,
      'the file changed after the deletion settled')
  }

  console.log(`\n${pass} passed, ${fail} failed`)
  win.destroy()
  await fs.rm(root, { recursive: true, force: true }).catch(() => {})
  app.exit(fail === 0 ? 0 : 1)
})
