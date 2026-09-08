import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import { LocalWorkspaceProvider } from '../src/core/workspace/LocalWorkspaceProvider'
import { checkRenpyRoot, listScriptFiles, toFileSlug } from '../src/core/renpy/detect'
import { parseEpisode } from '../src/core/renpy/labels'
import {
  newSidecarProject,
  readOutline,
  readSidecarProject,
  reconcileBeats,
  writeOutline,
  writeSidecarProject
} from '../src/core/projects/sidecar'
import { DEFAULT_SETTINGS } from '../src/shared/types'
import { scanCharacters } from '../src/core/renpy/characters'
import { contrastRatio, readableOn } from '../src/renderer/src/color'
import { buildLabeller } from '../src/renderer/src/characterLabel'
import { readReference, writeReference } from '../src/core/projects/reference'
import { buildLinkIndex, parseLinks, linkedNames } from '../src/renderer/src/wikiLink'
import { centreIndex } from '../src/renderer/src/anchor'
import { shouldWriteReference } from '../src/renderer/src/state/referenceSave'
import { renameCharacter } from '../src/core/renpy/rename'
import { defineCharacter } from '../src/core/renpy/define'
import { renameVariable } from '../src/core/renpy/renameVariable'
import { __testing as restructureTesting } from '../src/core/renpy/restructure'
import { renameLabelIn } from '../src/core/renpy/renameLabel'
import { characterVarName, freeName, toVarName } from '../src/shared/renpy/names'
import { resolveImageName, readPortrait } from '../src/core/renpy/images'
import { imageNameAt } from '../src/renderer/src/imageHover'
import { appendBeat, moveBeat, planRemoveBeat, removeBeat } from '../src/core/renpy/restructure'
import { classifyLine, needsProofreading, needsTranslation } from '../src/core/passes/language'
import { buildPrompt, buildProofreadPrompt, parseResponse } from '../src/core/passes/prompt'
import { runPass } from '../src/core/passes'
import { cliRunner } from '../src/core/passes/runner'
import { clampQuality, convertRender, findFfmpeg, planRenderSync, probeFfmpeg, targetDirFor } from '../src/core/renders'
import { commit, fetchStatus, pull, push, readStatus, resolvePull } from '../src/core/git'
import { createUserStore } from '../src/server/users'
import { createSessionStore } from '../src/server/sessions'
import {
  clearedCookie,
  createAttemptLimiter,
  isWrite,
  mayPerform,
  arrivedOverHttps,
  originAllowed,
  readCookie,
  refusalFor,
  sessionCookie
} from '../src/server/auth'
import { IPC } from '../src/shared/api'
import { canvasQuality } from '../src/main/encoder'
import { centreIndex, nearestLine } from '../src/renderer/src/anchor'
import { matchingIndexes, offsetsIn, step } from '../src/renderer/src/find'
import { matchSpeakers, speakerRank } from '../src/renderer/src/speakerMatch'
import {
  escapeText,
  parseDocument,
  dropSpentPass,
  serializeDocument,
  toggleMarkup,
  touch,
  unescapeText,
  adjustSize
} from '../src/shared/renpy/document'

const SCRATCH = path.resolve(process.env.SMOKE_DIR ?? '.', 'testproj')
/**
 * Two sample projects that travel with the tests.
 *
 * They used to be somebody's actual games, which meant the suite only ran on
 * one machine and told a stranger cloning this nothing at all. These are small
 * and made up, but shaped like the real thing: one project with chapters under
 * game/scripts, one with a single script.rpy straight in game/.
 */
// Relative to where the suite is run from, not to this file: it is bundled
// before it runs, so import.meta.url points into node_modules/.cache.
const FIXTURE = path.resolve(process.env.SMOKE_DIR ?? '.', 'tests', 'fixture')
const EPISODIC = path.join(FIXTURE, 'episodic')
const FLAT = path.join(FIXTURE, 'flat')

let pass = 0
let fail = 0
function check(name: string, cond: boolean, detail = '') {
  if (cond) {
    pass++
    console.log(`  ok   ${name}`)
  } else {
    fail++
    console.log(`  FAIL ${name}${detail ? ' -- ' + detail : ''}`)
  }
}

async function main() {
  await fs.rm(SCRATCH, { recursive: true, force: true })
  await fs.mkdir(path.join(SCRATCH, 'game'), { recursive: true })

  // A minimal Ren'Py project shaped like the flat sample: script.rpy directly in game/.
  const flatSource = await fs.readFile(path.join(FLAT, 'game', 'script.rpy'), 'utf8')
  await fs.writeFile(path.join(SCRATCH, 'game', 'script.rpy'), flatSource, 'utf8')
  await fs.mkdir(path.join(SCRATCH, 'game', 'images'), { recursive: true })

  console.log('\n[detect]')
  const bad = await checkRenpyRoot(path.join(SCRATCH, 'game'))
  check('rejects a folder with no game/', !bad.valid, bad.reason)

  const ok = await checkRenpyRoot(SCRATCH)
  check('accepts the project root', ok.valid, ok.reason)
  check('offers game/ as a script dir', ok.scriptDirCandidates.includes(''), JSON.stringify(ok.scriptDirCandidates))
  check('ignores images/ as a script dir', !ok.scriptDirCandidates.includes('images'))

  const episodic = await checkRenpyRoot(EPISODIC)
  check('a project with chapters resolves to game/scripts',
    episodic.valid && episodic.scriptDirCandidates.includes('scripts'),
    JSON.stringify(episodic.scriptDirCandidates))

  const chapters = await listScriptFiles(EPISODIC, 'scripts')
  check('lists the chapters', chapters.includes('chapter_1.rpy'), chapters.join(','))
  check('excludes engine boilerplate',
    !chapters.includes('screens.rpy') && !chapters.includes('options.rpy'), chapters.join(','))
  check('sorts numerically, so 10 comes after 2',
    chapters.indexOf('chapter_2.rpy') < chapters.indexOf('chapter_10.rpy'), chapters.join(','))

  console.log('\n[slug]')
  check('Episode 1 -> episode_1', toFileSlug('Episode 1') === 'episode_1')
  check("Ren'Py Ep 2 -> renpy_ep_2", toFileSlug("Ren'Py Ep 2") === 'renpy_ep_2', toFileSlug("Ren'Py Ep 2"))
  check('trims separators', toFileSlug('  Act -- III  ') === 'act_iii', toFileSlug('  Act -- III  '))

  console.log('\n[sidecar]')
  const ws = new LocalWorkspaceProvider(SCRATCH)
  check('no project before creation', (await readSidecarProject(ws)) === null)

  const sc = newSidecarProject('Flat Sample', { ...DEFAULT_SETTINGS, scriptDir: '', linear: true })
  await writeSidecarProject(ws, sc)
  const readBack = await readSidecarProject(ws)
  check('project round-trips', readBack?.name === 'Flat Sample' && readBack.settings.scriptDir === '')

  console.log('\n[containment]')
  let escaped = false
  try {
    await ws.readText('../../../Windows/System32/drivers/etc/hosts')
  } catch {
    escaped = true
  }
  check('refuses paths escaping the project root', escaped)

  console.log('\n[beats]')
  const parsed = parseEpisode('script.rpy', flatSource)
  check('finds the start label', parsed.labels.length === 1 && parsed.labels[0].label === 'start')
  check('detects the BOM', parsed.hadBom)
  check('start ends hand-authored (return)', parsed.labels[0].endKind === 'hand-authored',
    parsed.labels[0].endKind)

  let beats = reconcileBeats([], 'ep1', parsed.labels.map((l) => l.label))
  check('creates a beat per label', beats.length === 1 && beats[0].label === 'start')

  // Attach metadata, then simulate the label being renamed outside the app.
  beats[0] = { ...beats[0], description: 'opening scene' }
  const afterRename = reconcileBeats(beats, 'ep1', ['start_v2'])
  const orphan = afterRename.find((b) => b.description === 'opening scene')
  check('keeps notes when a label vanishes', !!orphan && orphan.label === null)
  check('adds a beat for the new label', afterRename.some((b) => b.label === 'start_v2'))
  check('does not delete anything', afterRename.length === 2, String(afterRename.length))

  await writeOutline(ws, { version: 1, beats: afterRename })
  check('outline round-trips', (await readOutline(ws)).beats.length === 2)

  console.log('\n[byte fidelity: read -> write -> compare]')
  const roundTripped = ['script', 'chapter_1', 'chapter_2', 'chapter_10']
  for (const c of roundTripped) {
    const src = path.join(EPISODIC, "game", "scripts", c + ".rpy")
    const original = await fs.readFile(src)
    const asText = original.toString('utf8')
    await ws.writeText(`roundtrip/${c}.rpy`, asText)
    const written = await fs.readFile(path.join(SCRATCH, 'roundtrip', `${c}.rpy`))
    check(`${c}.rpy survives a read/write cycle byte-for-byte`, original.equals(written),
      `${original.length} vs ${written.length} bytes`)
  }

  const flatOriginal = await fs.readFile(path.join(FLAT, 'game', 'script.rpy'))
  await ws.writeText('roundtrip/flat.rpy', flatOriginal.toString('utf8'))
  const flatWritten = await fs.readFile(path.join(SCRATCH, 'roundtrip', 'flat.rpy'))
  check('BOM file survives a read/write cycle byte-for-byte', flatOriginal.equals(flatWritten),
    `${flatOriginal.length} vs ${flatWritten.length} bytes`)


  console.log('\n[document: classification]')
  const sample = [
    'label D16_MEETING:',
    '    # Omar is on bed with a beer in his hand',
    '    omar "Kde se flaka?"',
    '    omar serious "Could it still be there?"',
    '    "A narrator line."',
    '    play music morning fadein 1 fadeout 3',
    '    $ current_chapter = "Ch.9 - Morning"',
    '    scene ch9_diner_1 with Fade(1, 1, 2)',
    '    menu:',
    '        "But...":',
    '            jump D16_BACCHUS_2',
    'define audio.heartbeats = "audio/fx/heartbeats.mp3"',
    'image side nadia = "portraits/nadia_normal.png"',
    ''
  ].join('\n')
  const doc = parseDocument(sample)
  const kinds = doc.nodes.map((n) => n.kind)
  const at = (i: number) => kinds[i]

  check('label line', at(0) === 'label', at(0))
  check('comment becomes an action', at(1) === 'action', at(1))
  check('plain dialogue', at(2) === 'dialogue', at(2))
  check('dialogue with an expression', at(3) === 'dialogue', at(3))
  check('narrator line', at(4) === 'dialogue', at(4))
  check('play statement stays raw', at(5) === 'raw', at(5))
  check('$ python line stays raw', at(6) === 'raw', at(6))
  check('scene statement stays raw', at(7) === 'raw', at(7))
  check('menu stays raw', at(8) === 'raw', at(8))
  check('menu choice recognised', at(9) === 'choice', at(9))
  check('jump stays raw', at(10) === 'raw', at(10))
  check('define stays raw', at(11) === 'raw', at(11))
  check('image side stays raw', at(12) === 'raw', at(12))

  const withExpr = doc.nodes[3] as any
  check('expression parsed as attribute',
    withExpr.speaker === 'omar' && withExpr.attributes.join(',') === 'serious',
    withExpr.speaker + ' / ' + withExpr.attributes)
  check('narrator has no speaker', (doc.nodes[4] as any).speaker === null)
  check('action text strips the hash',
    (doc.nodes[1] as any).text === 'Omar is on bed with a beer in his hand',
    (doc.nodes[1] as any).text)

  console.log('\n[document: escaping and markup]')
  const tricky = 'She said \\"no\\" and left'
  check('escape/unescape round-trips', escapeText(unescapeText(tricky)) === tricky,
    escapeText(unescapeText(tricky)))
  const bolded = toggleMarkup('hello world', 0, 5, 'bold')
  check('bold wraps a selection', bolded.text === '{b}hello{/b} world', bolded.text)
  const unbolded = toggleMarkup(bolded.text, bolded.start, bolded.end, 'bold')
  check('bold toggles back off', unbolded.text === 'hello world', unbolded.text)
  const ital = toggleMarkup('a b c', 2, 3, 'italic')
  check('italic wraps a selection', ital.text === 'a {i}b{/i} c', ital.text)

  console.log('\n[document: editing]')
  const editedDoc = {
    ...doc,
    nodes: doc.nodes.map((n) => (n.id === 'n2' ? touch(n as any, { text: 'Kde je?' }) : n))
  }
  const out = serializeDocument(editedDoc)
  check('edited line is regenerated', out.includes('    omar "Kde je?"'))
  check('untouched lines emit verbatim', out.includes('    play music morning fadein 1 fadeout 3'))
  check('edited document re-parses to the same shape',
    parseDocument(out).nodes.map((n) => n.kind).join(',') === kinds.join(','))

  console.log('\n[document: exact round-trip on every real script]')
  const scriptDir = path.join(EPISODIC, 'game', 'scripts')
  for (const f of (await fs.readdir(scriptDir)).filter((x) => x.endsWith('.rpy'))) {
    const src = await fs.readFile(path.join(scriptDir, f), 'utf8')
    const back = serializeDocument(parseDocument(src))
    check(f + ' round-trips exactly', back === src,
      back.length === src.length ? 'same length, content differs' : src.length + ' -> ' + back.length + ' chars')
  }
  const flatText = await fs.readFile(path.join(FLAT, 'game', 'script.rpy'), 'utf8')
  check('a script with a BOM round-trips exactly',
    serializeDocument(parseDocument(flatText)) === flatText)

  console.log('\n[document: line endings and EOF]')
  const eolCases: [string, string][] = [
    ['LF', 'a\nb\nc\n'],
    ['CRLF', 'a\r\nb\r\nc\r\n'],
    ['no trailing newline', 'a\nb\nc'],
    ['mixed endings', 'a\r\nb\nc\r\n'],
    ['empty file', ''],
    ['only a newline', '\n'],
    ['trailing blank lines', 'a\n\n\n']
  ]
  for (const [nm, txt] of eolCases) {
    check(nm + ' round-trips', serializeDocument(parseDocument(txt)) === txt,
      JSON.stringify(serializeDocument(parseDocument(txt))))
  }


  console.log('\n[characters: scanned from the project itself]')
  const cast = await scanCharacters(EPISODIC)
  const byVar = new Map(cast.map((c) => [c.varName, c]))
  check('finds the cast', cast.length >= 7, String(cast.length))
  const ava = byVar.get('ava')
  check('a character resolves to its display name', !!ava && ava.name === 'Ava',
    ava ? ava.name : 'missing')
  check('and keeps its colour', ava?.color === '#ffffb2', ava?.color ?? 'none')
  check('expressions come from the portrait files',
    (ava?.expressions.length ?? 0) === 5, String(ava?.expressions.length))
  check('and are the ones on disk',
    !!ava && ['happy', 'sad', 'angry', 'smirk'].every((e) => ava.expressions.includes(e)),
    JSON.stringify(ava?.expressions))
  const ben = byVar.get('ben')
  check('a second character has its own', (ben?.expressions.length ?? 0) === 2,
    String(ben?.expressions.length))
  const avaAlter = byVar.get('ava_alter')
  check('separate image tag keeps its own expressions',
    !!avaAlter && avaAlter.expressions.includes('explaining') && !ava!.expressions.includes('explaining'),
    JSON.stringify(avaAlter?.expressions))
  const thoughts = byVar.get('ava_thoughts')
  check('image= attribute maps a variant onto the base tag',
    !!thoughts && thoughts.imageTag === 'ava' && thoughts.expressions.includes('happy'),
    JSON.stringify(thoughts))
  const noPortrait = byVar.get('quinn')
  check('character without portraits has no expressions',
    !!noPortrait && noPortrait.expressions.length === 0, String(noPortrait?.expressions.length))

  const flatCast = await scanCharacters(FLAT)
  check('a one-file project scans too', flatCast.some((c) => c.varName === 'mara'),
    JSON.stringify(flatCast.map((c) => c.varName)))

  console.log('\n[colour: character names on the dark writer ground]')
  const BG = '#16161a'
  const px = (h: string) => ({
    r: parseInt(h.replace('#','').slice(0,2),16),
    g: parseInt(h.replace('#','').slice(2,4),16),
    b: parseInt(h.replace('#','').slice(4,6),16)
  })
  const coloured = (await scanCharacters(EPISODIC)).filter((c) => c.color)
  const ratios = coloured.map((c) => contrastRatio(px(readableOn(c.color, BG, '#e6e6ea')), px(BG)))
  check('every character colour is legible after adjustment',
    Math.min(...ratios) >= 4.5, 'worst ' + Math.min(...ratios).toFixed(2) + ':1')
  check('an already-legible colour is left alone',
    readableOn('#ffffb2', BG, '#e6e6ea').toLowerCase() === '#ffffb2')
  check('a near-invisible colour is lifted',
    readableOn('#36393F', BG, '#e6e6ea').toLowerCase() !== '#36393f')
  const lifted = px(readableOn('#36393F', BG, '#e6e6ea'))
  check('lifting preserves the hue (stays a blue-grey)',
    lifted.b > lifted.r && Math.abs(lifted.g - lifted.b) < 40,
    JSON.stringify(lifted))
  check('an unparseable colour falls back',
    readableOn('nonsense', BG, '#e6e6ea') === '#e6e6ea')
  check('an undefined colour falls back', readableOn(undefined, BG, '#e6e6ea') === '#e6e6ea')

  console.log('\n[character labels: telling variants apart]')
  const cast2 = await scanCharacters(EPISODIC)
  const find = (v: string) => cast2.find((c) => c.varName === v)
  const label2 = buildLabeller(cast2)
  const lbl = (v: string) => label2(v, find(v))
  check('plain character has no variant marker',
    lbl('ben').name === 'BEN' && lbl('ben').variant === null, JSON.stringify(lbl('ben')))
  check('ben_thoughts is marked as thoughts',
    lbl('ben_thoughts').name === 'BEN' && lbl('ben_thoughts').variant === 'thoughts',
    JSON.stringify(lbl('ben_thoughts')))
  check('ava_thoughts is marked too', lbl('ava_thoughts').variant === 'thoughts',
    JSON.stringify(lbl('ava_thoughts')))
  check('a unique short variable gets no badge (cora is "Cora Vale")',
    lbl('cora').variant === null, JSON.stringify(lbl('cora')))
  check('a uniquely named variant gets no badge either',
    lbl('ava_alter').variant === null, JSON.stringify(lbl('ava_alter')))
  check('cora_thoughts is marked from its group base',
    lbl('cora_thoughts').variant === 'thoughts', JSON.stringify(lbl('cora_thoughts')))
  check('nico_memory is marked as memory',
    lbl('nico_memory').variant === 'memory', JSON.stringify(lbl('nico_memory')))
  check('a differently named character keeps no badge',
    lbl('nico_unknown').variant === null, JSON.stringify(lbl('nico_unknown')))
  check('unknown speaker still renders', label2('nobody', undefined).name === 'NOBODY')

  const flatCastAgain = await scanCharacters(FLAT)
  const messenger = flatCastAgain.find((c) => c.varName === 'mara_msg')
  const jl = buildLabeller(flatCastAgain)('mara_msg', messenger)
  check('mara_msg reads as MARA with a msg marker',
    jl.name === 'MARA' && jl.variant === 'msg', JSON.stringify(jl))
  check('the whole messenger cast is found',
    flatCastAgain.filter((c) => c.varName.endsWith('_msg')).length >= 7,
    String(flatCastAgain.filter((c) => c.varName.endsWith('_msg')).length))

  console.log('\n[portraits]')
  const ava2 = cast2.find((c) => c.varName === 'ava')
  check('portrait paths are recorded', Object.keys(ava2?.portraits ?? {}).length === 5,
    String(Object.keys(ava2?.portraits ?? {}).length))
  check('a known expression maps to its file',
    ava2?.portraits['happy'] === 'portraits/ava_happy.png', String(ava2?.portraits['happy']))
  check('the attribute-less default portrait is recorded',
    ava2?.defaultPortrait === 'portraits/ava_happy.png', String(ava2?.defaultPortrait))
  const thoughtsVariant = cast2.find((c) => c.varName === 'ava_thoughts')
  check('a variant shares the base portraits',
    thoughtsVariant?.portraits['happy'] === 'portraits/ava_happy.png',
    String(thoughtsVariant?.portraits['happy']))

  console.log('\n[font size markup]')
  const s1 = adjustSize('hello world', 0, 5, 2)
  check('grows a plain selection', s1.text === '{size=+2}hello{/size} world', s1.text)
  const s2 = adjustSize(s1.text, s1.start, s1.end, 2)
  check('growing again adjusts in place, not nested',
    s2.text === '{size=+4}hello{/size} world', s2.text)
  const s3 = adjustSize(s2.text, s2.start, s2.end, -4)
  check('returning to zero removes the tags', s3.text === 'hello world', s3.text)
  const s4 = adjustSize('abc', 0, 3, -2)
  check('shrinks with a negative delta', s4.text === '{size=-2}abc{/size}', s4.text)
  const s5 = adjustSize('{size=+2}abc{/size}', 0, '{size=+2}abc{/size}'.length, 2)
  check('adjusts when the whole run is selected', s5.text === '{size=+4}abc{/size}', s5.text)
  check('a zero delta changes nothing', adjustSize('abc', 0, 3, 0).text === 'abc')

  console.log('\n[reference: storage]')
  const emptyRef = await readReference(ws)
  check('reads empty when nothing is written',
    emptyRef.characters.length === 0 && emptyRef.locations.length === 0 &&
    emptyRef.notes.length === 0 && emptyRef.characterOrder.length === 0)

  await writeReference(ws, {
    characters: [
      { id: 'c1', varNames: ['nadia', 'nadia_thoughts'], name: 'Nadia', age: '22',
        accent: 'Southerner', bio: 'Grew up in [[Little Rock]].', trivia: 'Hates mushrooms.' },
      { id: 'c2', varNames: [], name: 'Unwritten Person', storyHooks: 'Shows up in act 3.' }
    ],
    characterOrder: ['c2', 'c1'],
    locations: [{ id: 'l1', name: 'Little Rock', description: 'Where [[Nadia]] grew up.' }],
    notes: [{ id: 'n1', title: 'Arc 2 End', body: 'See [[Little Rock]].',
              updatedAt: '2026-01-01T00:00:00.000Z' }]
  })
  const back = await readReference(ws)
  check('a profile can cover several variables',
    back.characters[0].varNames.join(',') === 'nadia,nadia_thoughts',
    back.characters[0].varNames.join(','))
  check('trivia round-trips', back.characters[0].trivia === 'Hates mushrooms.')
  check('a profile with no variables survives', back.characters[1].varNames.length === 0)
  check('explicit ordering round-trips', back.characterOrder.join(',') === 'c2,c1')
  check('locations round-trip', back.locations[0].name === 'Little Rock')
  check('notes round-trip', back.notes[0].title === 'Arc 2 End')

  check('reference is split across three files',
    (await ws.exists('.renpywriter/characters.json')) &&
    (await ws.exists('.renpywriter/locations.json')) &&
    (await ws.exists('.renpywriter/notes.json')))

  console.log('\n[reference: migrating the old single-variable format]')
  await ws.writeText('.renpywriter/characters.json', JSON.stringify({
    version: 1,
    characters: [
      { id: 'old1', varName: 'omar', name: 'Omar', bio: 'kept' },
      { id: 'old2', varName: null, name: 'Nobody' }
    ]
  }))
  const migrated = await readReference(ws)
  check('a legacy varName becomes a one-item list',
    migrated.characters[0].varNames.join(',') === 'omar', JSON.stringify(migrated.characters[0]))
  check('a legacy null varName becomes an empty list',
    migrated.characters[1].varNames.length === 0)
  check('other fields survive migration', migrated.characters[0].bio === 'kept')
  check('the legacy field is dropped', migrated.characters[0].varName === undefined)

  await ws.writeText('.renpywriter/notes.json', 'this is not json{{{')
  const survived = await readReference(ws)
  check('a corrupt file degrades instead of throwing',
    survived.notes.length === 0 && survived.characters.length === 2)

  console.log('\n[reference: wiki links]')
  const index = buildLinkIndex({
    characters: [{ kind: 'character', id: 'nadia', name: 'Nadia' },
                 { kind: 'character', id: 'denny', name: 'Denny' }],
    locations: [{ kind: 'location', id: 'l1', name: 'Little Rock' }],
    notes: [{ kind: 'note', id: 'n1', name: 'Arc 2 End' }]
  })
  const segs = parseLinks('Grew up in [[Little Rock]] with [[Denny]].', index)
  check('splits text and links', segs.length === 5, String(segs.length))
  check('resolves a location', segs[1].kind === 'link' && segs[1].target?.id === 'l1')
  check('resolves a character', segs[3].kind === 'link' && segs[3].target?.id === 'denny')
  check('keeps the surrounding prose',
    segs.map((x) => (x.kind === 'text' ? x.text : '[[' + x.text + ']]')).join('') ===
      'Grew up in [[Little Rock]] with [[Denny]].')

  const unresolved = parseLinks('Meet [[Nobody]] later', index)
  check('an unmatched link still renders, marked unresolved',
    unresolved[1].kind === 'link' && unresolved[1].target === null)
  check('matching ignores case', parseLinks('[[little rock]]', index)[0].kind === 'link' &&
    (parseLinks('[[little rock]]', index)[0] as { target: { id: string } | null }).target?.id === 'l1')
  check('plain text yields a single run', parseLinks('no links here', index).length === 1)
  check('characters win over locations on a name clash',
    buildLinkIndex({
      characters: [{ kind: 'character', id: 'x', name: 'Dupe' }],
      locations: [{ kind: 'location', id: 'y', name: 'Dupe' }],
      notes: []
    }).get('dupe')?.kind === 'character')
  check('linkedNames lists every reference',
    linkedNames('a [[One]] b [[Two]]').join(',') === 'One,Two')

  console.log('\n[viewport anchor]')
  const tops = [0, 100, 220, 340, 500]
  check('picks the block containing the midpoint', centreIndex(tops, 250) === 2, String(centreIndex(tops, 250)))
  check('a midpoint in a margin gap takes the block above it',
    centreIndex(tops, 339) === 2, String(centreIndex(tops, 339)))
  check('an exact boundary belongs to that block', centreIndex(tops, 340) === 3, String(centreIndex(tops, 340)))
  check('above the first block yields nothing', centreIndex([10, 20], 5) === -1, String(centreIndex([10, 20], 5)))
  check('past the last block yields the last', centreIndex(tops, 99999) === 4, String(centreIndex(tops, 99999)))
  check('an empty list yields nothing', centreIndex([], 0) === -1)
  check('a single block at zero is found', centreIndex([0], 0) === 0)
  const many = Array.from({ length: 5000 }, (_, i) => i * 24)
  check('scales to a full chapter', centreIndex(many, 24 * 3210 + 5) === 3210, String(centreIndex(many, 24 * 3210 + 5)))

  console.log('\n[a planned scene is a real one]')
  {
    const L = String.fromCharCode(10)
    const script = [
      'label one:',
      '    ava "Something happens."',
      '    return',
      ''
    ].join(L)

    const grown = appendBeat(script, 'they_find_the_letter')
    check('the label is written into the script',
      grown.includes('label they_find_the_letter:'), grown)
    check('with a body, so Ren\'Py can load it',
      /label they_find_the_letter:\s*\n\s+pass/.test(grown), JSON.stringify(grown))
    check('and the scene before it is untouched',
      grown.includes('ava "Something happens."') && grown.includes('label one:'), grown)
    check('the file still parses', parseDocument(grown).nodes.length > 0)

    const spans = parseEpisode('ch.rpy', grown).labels
    const planned = spans.find((l) => l.label === 'they_find_the_letter')
    check('the new scene is found as a label', !!planned, JSON.stringify(spans.map((l) => l.label)))
    check('and is reported as having nothing in it', planned?.empty === true,
      JSON.stringify(planned))
    check('while the one that was written is not',
      spans.find((l) => l.label === 'one')?.empty === false,
      JSON.stringify(spans.find((l) => l.label === 'one')))

    // Emptiness is about content, not about length: structure does not count.
    const structural = parseEpisode('ch.rpy', [
      'label planned:',
      '    # somewhere for the letter scene',
      '',
      '    jump next_one',
      '',
      'label next_one:',
      '    ava "Here."',
      '    return',
      ''
    ].join(L)).labels
    check('a comment and a jump are still nothing written',
      structural.find((l) => l.label === 'planned')?.empty === true,
      JSON.stringify(structural.find((l) => l.label === 'planned')))

    // Two scenes planned with the same name must not collide: Ren'Py labels
    // are global, and a duplicate is a script that will not load.
    const twice = appendBeat(grown, 'they_find_the_letter_2')
    const both = parseEpisode('ch.rpy', twice).labels.map((l) => l.label)
    check('a second one can sit beside the first',
      both.filter((l) => l.startsWith('they_find_the_letter')).length === 2,
      JSON.stringify(both))
    check('and no name is repeated', new Set(both).size === both.length, JSON.stringify(both))
  }

  console.log('\n[removing a scene from the script]')
  {
    const L = String.fromCharCode(10)
    const script = [
      'label one:',
      '    ava "First."',
      '    jump three',
      '',
      'label two:',
      '    ava "Second."',
      '',
      'label three:',
      '    ava "Third."',
      '    return',
      ''
    ].join(L)

    // What it would cost, before anything is done.
    const plan = planRemoveBeat({ source: script, label: 'two' })
    check('the plan counts the lines that would go', plan.lines === 3, String(plan.lines))
    check('and finds nothing pointing at it', plan.referencedBy.length === 0,
      JSON.stringify(plan.referencedBy))

    const cut = removeBeat({ source: script, label: 'two' })
    check('the scene is gone from the script', !cut.source.includes('label two:'), cut.source)
    check('and its dialogue with it', !cut.source.includes('Second.'), cut.source)
    check('the scenes around it are untouched',
      cut.source.includes('label one:') && cut.source.includes('label three:'), cut.source)
    check('and the file still parses', parseDocument(cut.source).nodes.length > 0)

    // A scene something jumps to is refused, because the alternative is a
    // game that stops at that line.
    const guarded = removeBeat({ source: script, label: 'three' })
    check('a scene that is jumped to is refused', !!guarded.error, String(guarded.error))
    check('and says who jumps there',
      (guarded.error ?? '').includes('one'), String(guarded.error))
    check('and changes nothing', guarded.source === script, 'the script was rewritten')

    // A jump from another file counts too: labels are global in Ren'Py.
    const elsewhere = [{ fileName: 'other.rpy', text: 'label far:' + L + '    jump two' + L }]
    const acrossFiles = removeBeat({ source: script, label: 'two', jumpsFrom: elsewhere })
    check('a jump from another file is seen', !!acrossFiles.error, String(acrossFiles.error))
    check('and names the file it is in',
      (acrossFiles.error ?? '').includes('other.rpy'), String(acrossFiles.error))

    // Removing a scene that ran into the next one writes that out first, so
    // the story keeps doing what it did.
    const linear = [
      'label alpha:',
      '    ava "One."',
      '',
      'label beta:',
      '    ava "Two."',
      '',
      'label gamma:',
      '    ava "Three."',
      '    return',
      ''
    ].join(L)
    const middle = removeBeat({ source: linear, label: 'beta' })
    check('removing a fallen-through scene succeeds', !middle.error, String(middle.error))
    check('no jump is invented for the scene before it',
      !middle.source.includes('jump beta') && !middle.source.includes('jump gamma'),
      middle.source)
    check('and the plan said what would follow instead',
      planRemoveBeat({ source: linear, label: 'beta' }).runsIntoInstead?.to === 'gamma',
      JSON.stringify(planRemoveBeat({ source: linear, label: 'beta' }).runsIntoInstead))
    check('beta is gone', !middle.source.includes('label beta:'), middle.source)
  }

  console.log('\n[other languages in the script]')
  {
    // A script is not tidily two languages. It picks up a Swedish loan word, a
    // Japanese sign, a line somebody pasted from somewhere. Most of that is
    // none of the app's business -- but handing it back exactly as it arrived
    // very much is, and so is not "correcting" it into English.
    const lines = [
      ['Swedish', '    ava "Jag vet inte vad jag ska säga."'],
      ['Swedish with the letters that matter', '    ben "Skölden är trasig — vi måste vända om."'],
      ['Japanese', '    cora "何も言わずに、彼女は手紙を二度読んだ。"'],
      ['Japanese, shorter', '    nico "ドアが閉まる音がした。"'],
      ['Greek', '    dev "Το γράμμα ήταν άδειο."'],
      ['Russian', '    quinn "Всё уже решено."'],
      ['an emoji, which is not a letter at all', '    ava "That went well 🙂"']
    ]

    for (const [what, line] of lines) {
      const doc = parseDocument(line + String.fromCharCode(10))
      check(`${what} parses as dialogue`,
        doc.nodes[0]?.kind === 'dialogue', doc.nodes[0]?.kind ?? 'none')
      check(`${what} comes back byte for byte`,
        serializeDocument(doc) === line + String.fromCharCode(10),
        JSON.stringify(serializeDocument(doc)))
    }

    // Speaker cues are ASCII by Ren'Py's own rules, but what they say is not.
    const japanese = parseDocument('    cora "何も言わずに。"' + String.fromCharCode(10)).nodes[0]
    check('the speaker is still found in front of non-Latin text',
      japanese.kind === 'dialogue' && japanese.speaker === 'cora', JSON.stringify(japanese))
    check('and the words are kept whole',
      japanese.kind === 'dialogue' && japanese.text === '何も言わずに。',
      japanese.kind === 'dialogue' ? japanese.text : '')

    // Classification decides what gets sent to a language pass. Getting this
    // wrong means a proofreader quietly rewriting somebody's Japanese into
    // English, which is worse than doing nothing at all.
    check('a Japanese line is never sent to be proofread as English',
      !needsProofreading('何も言わずに、彼女は手紙を二度読んだ。'))
    check('nor a Russian one', !needsProofreading('Всё уже решено.'))
    check('nor Swedish with its own letters',
      !needsProofreading('Skölden är trasig, vi måste vända om.'))
    check('while plain English still is',
      needsProofreading('She read the letter twice and said nothing.'))

    // Non-ASCII is a hint, not proof: a line can be plain ASCII and still not
    // be English, which is what "unknown" is for.
    check('an ambiguous line is not confidently anything',
      classifyLine('Hej.') === 'unknown', classifyLine('Hej.'))
    check('and is therefore offered to both passes',
      needsProofreading('Hej.') && needsTranslation('Hej.'))
  }

  console.log('\n[reference saves: a write that waited a second]')
  {
    // Characters, locations and notes save on a debounce, so the write lands
    // over a second after the edit. What can happen in that second is the
    // whole problem: a project closed, another opened, or the same one
    // reopened and still loading.
    const A = 'C:/games/one'
    const B = 'C:/games/two'

    check('an ordinary edit is written',
      shouldWriteReference(A, A, A) === true)

    // The one that emptied a real project's characters. The reference had not
    // been read yet, so what was in memory was a blank placeholder -- and
    // writing it turned two people with names and ages into "characters": [].
    check('nothing is written before the reference has been read',
      shouldWriteReference(A, A, null) === false)

    check('one project\'s notes are not written into another',
      shouldWriteReference(A, B, A) === false)

    check('nor the other way round',
      shouldWriteReference(B, A, B) === false)

    check('a reference read from elsewhere is not written here',
      shouldWriteReference(A, A, B) === false)

    check('nothing is written with no project open',
      shouldWriteReference(A, null, A) === false)

    check('and not even when everything is null',
      shouldWriteReference(null, null, null) === false)
  }

  console.log('\n[rename: writing a display name back to the script]')
  await fs.mkdir(path.join(SCRATCH, 'game', 'scripts'), { recursive: true })
  const realScript = await fs.readFile(path.join(EPISODIC, 'game', 'scripts', 'script.rpy'), 'utf8')
  const scriptRel = 'game/scripts/script.rpy'
  const restore = async () => fs.writeFile(path.join(SCRATCH, scriptRel), realScript, 'utf8')
  await restore()

  const castBefore = await scanCharacters(SCRATCH)
  const avaDef = castBefore.find((c) => c.varName === 'ava')
  check('scanner records where a character is defined',
    avaDef?.sourceFile === scriptRel && typeof avaDef?.sourceLine === 'number',
    avaDef?.sourceFile + ':' + avaDef?.sourceLine)

  const r1 = await renameCharacter(ws, scriptRel, avaDef!.sourceLine!, 'ava', 'Ava Vale')
  check('rename succeeds', r1.ok, r1.reason)
  const after = await fs.readFile(path.join(SCRATCH, scriptRel), 'utf8')
  check('the display name changed',
    after.includes("define ava = Character('Ava Vale'"), 'not found')
  check('everything else on the line survived',
    after.includes('color="#ffffb2"') && after.includes('image="ava"'))
  check('only one line differs',
    after.split(String.fromCharCode(10)).filter((l, i) =>
      l !== realScript.split(String.fromCharCode(10))[i]).length === 1)
  check('the rest of the file is untouched byte for byte',
    after.length - realScript.length === 'Ava Vale'.length - 'Ava'.length,
    String(after.length - realScript.length))

  const rescanned = await scanCharacters(SCRATCH)
  check('a rescan sees the new name',
    rescanned.find((c) => c.varName === 'ava')?.name === 'Ava Vale')
  check('sibling characters kept their names',
    rescanned.find((c) => c.varName === 'ava_thoughts')?.name === 'Ava')

  await restore()
  const guard1 = await renameCharacter(ws, scriptRel, avaDef!.sourceLine!, 'ben', 'Nope')
  check('refuses when the line defines a different character', !guard1.ok, guard1.reason)
  const guard2 = await renameCharacter(ws, scriptRel, 1, 'ava', 'Nope')
  check('refuses when the line is not a define', !guard2.ok, guard2.reason)
  const guard3 = await renameCharacter(ws, scriptRel, 999999, 'nadia', 'Nope')
  check('refuses a line past the end', !guard3.ok, guard3.reason)
  const guard4 = await renameCharacter(ws, scriptRel, avaDef!.sourceLine!, 'ava', '   ')
  check('refuses an empty name', !guard4.ok, guard4.reason)
  const guard5 = await renameCharacter(ws, 'game/scripts/nope.rpy', 1, 'nadia', 'X')
  check('refuses a missing file', !guard5.ok, guard5.reason)
  check('no guard rewrote anything',
    (await fs.readFile(path.join(SCRATCH, scriptRel), 'utf8')) === realScript)

  const quoted = await renameCharacter(ws, scriptRel, avaDef!.sourceLine!, 'ava', "O'Hara")
  check('an apostrophe is escaped for the single-quoted literal', quoted.ok, quoted.reason)
  const withQuote = await scanCharacters(SCRATCH)
  check('the escaped name scans back correctly',
    withQuote.find((c) => c.varName === 'ava')?.name === "O'Hara",
    withQuote.find((c) => c.varName === 'ava')?.name)
  await restore()

  console.log('\n[keeping your place when the views swap]')
  {
    // The writer draws dialogue and headings. `scene`, `show` and `if` are
    // code, and code is not drawn there -- so the line the code view was
    // looking at very often does not exist in the writer, and asking to scroll
    // to a line that is not there scrolls nowhere. That is the whole bug: you
    // were at line 700 and the writer opened at the top of the file.
    const drawn = [1, 4, 5, 9, 20]

    check('a line that is drawn is used as it is', nearestLine(drawn, 5) === 5)
    check('a line that is not falls back to the block above it',
      nearestLine(drawn, 7) === 5, String(nearestLine(drawn, 7)))
    check('the scene above is the right answer, not the one below',
      nearestLine(drawn, 8) === 5, String(nearestLine(drawn, 8)))
    check('past the last one, the last one',
      nearestLine(drawn, 900) === 20, String(nearestLine(drawn, 900)))
    // Above everything drawn there is nothing to fall back to, so go forwards.
    check('before the first one, the first one',
      nearestLine([4, 9], 2) === 4, String(nearestLine([4, 9], 2)))
    check('an empty file has no answer at all', nearestLine([], 5) === null)

    // The other half of the same journey, unchanged but worth stating.
    check('the block at the middle of the screen is the one above the line',
      centreIndex([0, 100, 200, 300], 250) === 2)
  }

  console.log('\n[finding words]')
  {
    check('nothing is found for nothing', offsetsIn('the letter', '').length === 0)
    check('a word is found where it is',
      JSON.stringify(offsetsIn('the letter on the table', 'the')) === '[0,14]',
      JSON.stringify(offsetsIn('the letter on the table', 'the')))
    check('case is not a difference',
      JSON.stringify(offsetsIn('The Letter', 'letter')) === '[4]',
      JSON.stringify(offsetsIn('The Letter', 'letter')))
    // A reader stepping through matches would be right to expect both of these.
    check('overlapping occurrences all count',
      JSON.stringify(offsetsIn('aaa', 'aa')) === '[0,1]',
      JSON.stringify(offsetsIn('aaa', 'aa')))

    const lines = ['She reads it.', 'He says nothing.', 'She reads it again.']
    check('the blocks that contain it are listed',
      JSON.stringify(matchingIndexes(lines, 'reads')) === '[0,2]',
      JSON.stringify(matchingIndexes(lines, 'reads')))
    check('and none of them for a word nobody wrote',
      matchingIndexes(lines, 'zebra').length === 0)
    check('surrounding space in the query is ignored',
      JSON.stringify(matchingIndexes(lines, '  reads ')) === '[0,2]')

    // Wrapping rather than stopping: the last match is the end of the file,
    // not the end of the search.
    check('stepping forward moves on', step(0, 3, 1) === 1)
    check('and wraps at the end', step(2, 3, 1) === 0)
    check('stepping back wraps too', step(0, 3, -1) === 2)
    check('with nothing found there is nowhere to step', step(0, 0, 1) === -1)
  }

  console.log('\n[finding the right speaker as you type]')
  {
    const cast = [
      { varName: 'cook', name: 'Detective Cook' },
      { varName: 'detective_cook', name: 'Detective Cook' },
      { varName: 'dev', name: 'Dev' },
      { varName: 'ava', name: 'Ava' },
      { varName: 'ben_thoughts', name: 'Ben' }
    ] as never[]

    // The old behaviour: only what the name starts with. A character the game
    // calls Detective Cook could only be reached by typing 'de'.
    check('the start of the script name still wins',
      speakerRank({ varName: 'dev', name: 'Dev' }, 'de') === 0)
    check('the start of the display name is next',
      speakerRank({ varName: 'x1', name: 'Detective Cook' }, 'de') === 1)
    // The one that was missing.
    check('a later word in the name counts',
      speakerRank({ varName: 'x1', name: 'Detective Cook' }, 'cook') === 2,
      String(speakerRank({ varName: 'x1', name: 'Detective Cook' }, 'cook')))
    check('and a later word in the script name',
      speakerRank({ varName: 'detective_cook', name: 'Someone' }, 'cook') === 2,
      String(speakerRank({ varName: 'detective_cook', name: 'Someone' }, 'cook')))
    check('anywhere at all still counts, last',
      speakerRank({ varName: 'x1', name: 'Blackwood' }, 'ackwo') === 3,
      String(speakerRank({ varName: 'x1', name: 'Blackwood' }, 'ackwo')))
    check('and somebody unrelated does not',
      speakerRank({ varName: 'ava', name: 'Ava' }, 'cook') === null)

    check('typing the middle of a name finds them',
      matchSpeakers(cast, 'cook').map((c) => c.varName).join(',') === 'cook,detective_cook',
      JSON.stringify(matchSpeakers(cast, 'cook').map((c) => c.varName)))
    check('while the front of a name still comes first',
      matchSpeakers(cast, 'de')[0].varName === 'dev',
      JSON.stringify(matchSpeakers(cast, 'de').map((c) => c.varName)))
    check('nothing typed offers nobody', matchSpeakers(cast, '   ').length === 0)
    check('the list is kept short', matchSpeakers(cast, 'e', 2).length === 2)
  }

  console.log('\n[the jumps that keep file order and story order agreeing]')
  {
    const { relinkLinear } = restructureTesting
    const lines = (...parts: string[]): string => parts.join(String.fromCharCode(10)) + String.fromCharCode(10)

    // A planned beat is held open by `pass`. Once it ends in a jump it is held
    // open by the jump, and a beat reading `pass` and then `jump` says the
    // same thing twice -- one of them saying "nothing here yet".
    const planned = lines(
      'label one:',
      '    pass',
      '',
      'label two:',
      '    pass',
      '',
      'label three:',
      '    pass'
    )
    const linked = relinkLinear(planned)
    check('a jump replaces the placeholder rather than following it',
      !/pass[\s\S]*jump/.test(linked.text.slice(0, linked.text.indexOf('label two'))),
      linked.text)
    check('every scene but the last is pointed at the next',
      linked.text.includes('    jump two') && linked.text.includes('    jump three'),
      linked.text)
    check('and the last is left holding its placeholder',
      /label three:\s*\n\s+pass\s*$/.test(linked.text.trim() + String.fromCharCode(10)), linked.text)
    check('so nothing has both', !/pass\s*\n\s*jump/.test(linked.text), linked.text)

    // The one from a real project. Reorder often enough and the scene that
    // ends up last still carries a jump written when it was not, pointing
    // backwards into the middle of the file: a loop the outline cannot show.
    const stale = lines(
      'label one:',
      '    pass',
      '    jump two',
      '',
      'label two:',
      '    pass',
      '    jump three',
      '',
      'label three:',
      '    pass',
      '    jump two'
    )
    const fixed = relinkLinear(stale)
    check('the last scene loses a jump that points back into the file',
      !/label three:[\s\S]*jump/.test(fixed.text), fixed.text)
    check('and says so', fixed.warnings.some((w) => w.includes('last scene in the file')),
      JSON.stringify(fixed.warnings))
    check('while the scenes above it keep theirs',
      fixed.text.includes('    jump two') && fixed.text.includes('    jump three'), fixed.text)

    // A jump out of the file is how one episode leads to the next, and this
    // knows nothing about the files it cannot see.
    const onwards = lines('label one:', '    pass', '    jump EPISODE_2_START')
    const kept = relinkLinear(onwards)
    check('a jump out of the file is left alone',
      kept.text.includes('jump EPISODE_2_START'), kept.text)
  }

  console.log('\n[numbering a name that is already taken]')
  {
    const used = (...names: string[]) => (candidate: string) => names.includes(candidate)

    check('a free name is left alone', freeName('MORNING', used('EVENING')) === 'MORNING')
    check('a taken one is numbered', freeName('MORNING', used('MORNING')) === 'MORNING_2')
    check('and counts past the ones already there',
      freeName('MORNING', used('MORNING', 'MORNING_2')) === 'MORNING_3',
      freeName('MORNING', used('MORNING', 'MORNING_2')))

    // Appending without looking is how a name ends up mostly underscores and
    // twos. A second MORNING_2 is MORNING_3.
    check('a name that already ends in a number carries on counting',
      freeName('MORNING_2', used('MORNING_2')) === 'MORNING_3',
      freeName('MORNING_2', used('MORNING_2')))
    check('and keeps carrying on',
      freeName('MORNING_2', used('MORNING_2', 'MORNING_3', 'MORNING_4')) === 'MORNING_5',
      freeName('MORNING_2', used('MORNING_2', 'MORNING_3', 'MORNING_4')))
    check('so a name is never numbered twice over',
      !freeName('MORNING_2', used('MORNING_2')).includes('_2_'),
      freeName('MORNING_2', used('MORNING_2')))

    // A number that is part of the name rather than a count is still only a
    // place to carry on from.
    check('a chapter number is carried on from, not appended to',
      freeName('DAY_14', used('DAY_14')) === 'DAY_15', freeName('DAY_14', used('DAY_14')))

    // And the same rule reaches the places that name things.
    check('character variables are numbered the same way',
      characterVarName('Mara', ['mara', 'mara_2']) === 'mara_3',
      characterVarName('Mara', ['mara', 'mara_2']))
    check('and one whose name already ends in a number carries on too',
      characterVarName('Mara 2', ['mara_2']) === 'mara_3',
      characterVarName('Mara 2', ['mara_2']))
  }

  console.log('\n[renaming a scene, and everything that points at it]')
  {
    const lines = (...parts: string[]): string => parts.join(String.fromCharCode(10)) + String.fromCharCode(10)

    const script = lines(
      'label ch2_yard:',
      '    ava "Out here."',
      '    jump ch2_yard_night',
      '',
      'label ch2_yard_night:',
      '    ava "Later, in the yard."',
      '    return',
      '',
      'label elsewhere:',
      '    "They talked about the yard."',
      '    call ch2_yard from _call_1',
      '    jump ch2_yard'
    )

    const done = renameLabelIn(script, 'ch2_yard', 'CH2_THE_YARD')
    check('the label itself is renamed',
      done.text.includes('label CH2_THE_YARD:'), done.text)
    check('and every jump that reaches it',
      done.text.includes('    jump CH2_THE_YARD') &&
      !/jump ch2_yard$/m.test(done.text), done.text)
    // Ren'Py writes `call X from Y` when it needs somewhere to return to.
    check('a call keeps the label it returns to',
      done.text.includes('    call CH2_THE_YARD from _call_1'), done.text)
    // The mistake a plain search and replace makes.
    check('a longer label that starts the same is untouched',
      done.text.includes('label ch2_yard_night:') &&
      done.text.includes('    jump ch2_yard_night'), done.text)
    check('and the word in a line of dialogue is left alone',
      done.text.includes('"They talked about the yard."'), done.text)
    // The label, the call and the jump. Not the one to ch2_yard_night, and not
    // the sentence about the yard.
    check('three lines changed and no more', done.lines === 3, String(done.lines))

    // A label that takes parameters is still a label.
    const withArgs = renameLabelIn(
      lines('label greet(name="x"):', '    return'), 'greet', 'SAY_HELLO')
    check('a label with parameters keeps them',
      withArgs.text.includes('label SAY_HELLO(name="x"):'), withArgs.text)

    // Nothing to do is not a rewrite.
    const untouched = renameLabelIn(script, 'nobody_here', 'SOMETHING')
    check('a name that is not there changes nothing',
      untouched.text === script && untouched.lines === 0)

    const crlf = 'label a:' + String.fromCharCode(13, 10) + '    jump a' + String.fromCharCode(13, 10)
    const windows = renameLabelIn(crlf, 'a', 'B')
    check('a CRLF file stays a CRLF file',
      windows.text === 'label B:' + String.fromCharCode(13, 10) + '    jump B' +
        String.fromCharCode(13, 10), JSON.stringify(windows.text))
  }

  console.log('\n[removing a beat the one above runs into]')
  {
    const lines = (...parts: string[]): string => parts.join(String.fromCharCode(10)) + String.fromCharCode(10)

    // Every beat in a reordered episode ends by jumping to the next, because
    // RW writes those itself. Refusing to remove a beat because of the app's
    // own bookkeeping made every beat in such an episode permanent.
    const script = lines(
      'label one:',
      '    ava "First."',
      '    jump two',
      '',
      'label two:',
      '    ava "Second."',
      '    jump three',
      '',
      'label three:',
      '    ava "Third."',
      '    return'
    )

    const plan = planRemoveBeat({ source: script, label: 'two' })
    check('the scene above is not counted as a blocker',
      plan.referencedBy.length === 0, JSON.stringify(plan.referencedBy))
    check('it is counted as one to repoint',
      JSON.stringify(plan.retargeted) === '["one"]', JSON.stringify(plan.retargeted))

    const cut = removeBeat({ source: script, label: 'two' })
    check('so the beat can actually go', !cut.error, String(cut.error))
    check('and the scene above now jumps past it',
      cut.source.includes('    jump three') && !cut.source.includes('    jump two'), cut.source)
    check('with the beat itself gone',
      !cut.source.includes('label two:') && !cut.source.includes('Second.'), cut.source)

    // Nothing after it: the jump goes rather than pointing at nothing.
    const last = removeBeat({ source: script, label: 'three' })
    check('removing the last scene takes the jump into it with it',
      !last.error && !last.source.includes('jump three'), String(last.error) + last.source)
    check('and leaves the scene above ending where it ends',
      last.source.includes('    ava "Second."'), last.source)

    // A jump that reaches past a scene is the writer skipping something on
    // purpose, and is still not ours to move.
    const skipping = lines(
      'label one:',
      '    ava "First."',
      '    jump three',
      '',
      'label two:',
      '    ava "Second."',
      '',
      'label three:',
      '    ava "Third."',
      '    return'
    )
    const refused = removeBeat({ source: skipping, label: 'three' })
    check('a scene reached by a jump from further up is still refused',
      !!refused.error, String(refused.error))
    check('and nothing was written', refused.source === skipping)
  }

  console.log('\n[renaming a character in the script]')
  {
    const RENAME = path.join(SCRATCH, 'renaming')
    const renameWs = new LocalWorkspaceProvider(RENAME)

    const build = async (files: Record<string, string[]>): Promise<void> => {
      await fs.rm(RENAME, { recursive: true, force: true })
      await fs.mkdir(path.join(RENAME, 'game'), { recursive: true })
      for (const [name, lines] of Object.entries(files)) {
        await fs.writeFile(path.join(RENAME, 'game', name), lines.join(String.fromCharCode(10)) + String.fromCharCode(10), 'utf8')
      }
    }
    const read = async (name: string): Promise<string> =>
      fs.readFile(path.join(RENAME, 'game', name), 'utf8')

    // The ordinary case, and everything around it that must not move.
    await build({
      'characters.rpy': [
        'define cook = Character("Cook", image="cook")',
        'define cook_thoughts = Character("Cook")'
      ],
      'chapter.rpy': [
        'label start:',
        '    scene bg_room',
        '    show cook neutral',
        '    cook "Evening."',
        '    cook tired "It has been a long one."',
        '    cook_thoughts "He should not have said that."',
        '    "The cook put the kettle on."',
        '    e "Have you met cook?"',
        '    return'
      ]
    })

    const done = await renameVariable(RENAME, renameWs, 'cook', 'detective_cook')
    check('a rename that is only speech and a define goes through', done.ok, done.reason)
    const defines = await read('characters.rpy')
    const chapter = await read('chapter.rpy')

    check('the define is renamed',
      defines.includes('define detective_cook = Character("Cook", image="cook")'),
      defines)
    check('every line they speak follows',
      chapter.includes('    detective_cook "Evening."') &&
      chapter.includes('    detective_cook tired "It has been a long one."'), chapter)
    // The image tag is a different world from the variable. Renaming inside it
    // would break the pictures to fix nothing.
    check('the image tag is left exactly as it was',
      chapter.includes('    show cook neutral') &&
      defines.includes('image="cook"'), chapter)
    check('a sibling variable that starts the same is untouched',
      defines.includes('define cook_thoughts = Character("Cook")') &&
      chapter.includes('    cook_thoughts "He should not have said that."'), chapter)
    check('the word inside a line of dialogue is left alone',
      chapter.includes('"The cook put the kettle on."') &&
      chapter.includes('e "Have you met cook?"'), chapter)
    check('and nothing else in the file moved',
      chapter.includes('label start:') && chapter.includes('    scene bg_room') &&
      chapter.includes('    return'), chapter)

    // Used as more than a speaker: rewriting blind would leave a game that
    // loads and then breaks, so it refuses and says where.
    await build({
      'characters.rpy': ['define cook = Character("Cook")'],
      'chapter.rpy': [
        'label start:',
        '    cook "Evening."',
        '    $ cook.name = "Detective Cook"',
        '    return'
      ]
    })
    const refused = await renameVariable(RENAME, renameWs, 'cook', 'detective_cook')
    check('a variable used in Python is refused', !refused.ok, JSON.stringify(refused))
    check('and the place is named',
      (refused.mentions ?? []).some((m) => m.includes('chapter.rpy:3')),
      JSON.stringify(refused.mentions))
    check('nothing at all was written',
      (await read('chapter.rpy')).includes('    cook "Evening."') &&
      (await read('characters.rpy')).includes('define cook ='),
      await read('chapter.rpy'))

    // A name somebody else already has.
    await build({
      'characters.rpy': [
        'define cook = Character("Cook")',
        'define ava = Character("Ava")'
      ]
    })
    const taken = await renameVariable(RENAME, renameWs, 'cook', 'ava')
    check('a name already defined is refused', !taken.ok && /already defined/.test(taken.reason ?? ''),
      String(taken.reason))
    const keyword = await renameVariable(RENAME, renameWs, 'cook', 'class')
    check('and so is one Python would not accept', !keyword.ok, String(keyword.reason))
    const punctuated = await renameVariable(RENAME, renameWs, 'cook', 'detective cook')
    check('nor one with a space in it', !punctuated.ok, String(punctuated.reason))

    // A label that happens to share the name is not the character.
    await build({
      'characters.rpy': ['define cook = Character("Cook")'],
      'chapter.rpy': ['label cook:', '    cook "Evening."', '    jump cook', '    return']
    })
    const pastLabels = await renameVariable(RENAME, renameWs, 'cook', 'detective_cook')
    check('a label of the same name does not block the rename', pastLabels.ok,
      String(pastLabels.reason))
    const labelled = await read('chapter.rpy')
    check('and is left alone, being a different thing entirely',
      labelled.includes('label cook:') && labelled.includes('    jump cook') &&
      labelled.includes('    detective_cook "Evening."'), labelled)

    // Windows line endings survive, as everywhere else.
    await fs.rm(RENAME, { recursive: true, force: true })
    await fs.mkdir(path.join(RENAME, 'game'), { recursive: true })
    const CRLF2 = String.fromCharCode(13, 10)
    await fs.writeFile(path.join(RENAME, 'game', 'characters.rpy'),
      'define cook = Character("Cook")' + CRLF2 + 'label x:' + CRLF2 + '    cook "Hi."' + CRLF2,
      'utf8')
    const windows = await renameVariable(RENAME, renameWs, 'cook', 'detective_cook')
    check('a CRLF file is rewritten as a CRLF file', windows.ok, String(windows.reason))
    const wtext = await read('characters.rpy')
    check('with every line still ending the way it did',
      wtext.split(String.fromCharCode(10)).every((l) => l === '' || l.endsWith(String.fromCharCode(13))),
      JSON.stringify(wtext))

    check('renaming to the same name does nothing at all',
      (await renameVariable(RENAME, renameWs, 'detective_cook', 'detective_cook')).ok)

    await fs.rm(RENAME, { recursive: true, force: true })
  }

  console.log('\n[the placeholder in a planned scene]')
  {
    const through = (source: string): string => {
      const doc = parseDocument(source)
      return serializeDocument({ ...doc, nodes: dropSpentPass(doc.nodes) })
    }
    const lines = (...parts: string[]): string => parts.join(String.fromCharCode(10)) + String.fromCharCode(10)

    // A beat planned in the outline is a label and a pass. The pass is the app
    // saying "nothing here yet", and the first real line says otherwise.
    check('the pass goes once the scene has a line',
      through(lines('label a:', '    pass', '    "Hello."')) ===
        lines('label a:', '    "Hello."'),
      JSON.stringify(through(lines('label a:', '    pass', '    "Hello."'))))

    check('a scene that is still only a pass keeps it',
      through(lines('label a:', '    pass')) === lines('label a:', '    pass'),
      JSON.stringify(through(lines('label a:', '    pass'))))

    check('a scene already written is left alone',
      through(lines('label a:', '    "Hello."')) === lines('label a:', '    "Hello."'))

    // Nothing is ever added. Ren'Py loads a label with an empty block quite
    // happily -- a real project here ships eleven of them -- so writing a pass
    // into those would turn typing one word into a diff of every scene.
    const hollow = lines('label a:', '', '', 'label b:', '    "Hi."')
    check('a label with nothing under it is left exactly as it is',
      through(hollow) === hollow, JSON.stringify(through(hollow)))

    // The one that matters. Scripts are full of pass inside a menu choice or
    // an else, where it is the only thing keeping that block legal. Deleting
    // one from an edit elsewhere in the file would break the game.
    const nested = lines(
      'label a:',
      '    "Hello."',
      '    if seen:',
      '        "Again."',
      '    else:',
      '        pass',
      '    "Bye."'
    )
    check('a pass inside an else is never touched', through(nested) === nested,
      JSON.stringify(through(nested)))

    const menu = lines(
      'label a:',
      '    menu:',
      '        "Say nothing":',
      '            pass',
      '        "Answer":',
      '            "Yes."'
    )
    check('nor one inside a menu choice', through(menu) === menu, JSON.stringify(through(menu)))

    // Not the first line under the label, so not the app's placeholder.
    const later = lines('label a:', '    "Hello."', '    pass')
    check('nor one that comes after the words', through(later) === later,
      JSON.stringify(through(later)))

    // Blank lines between the label and the pass do not change what it is.
    check('blank lines above the pass make no difference',
      through(lines('label a:', '', '    pass', '    "Hi."')) ===
        lines('label a:', '', '    "Hi."'),
      JSON.stringify(through(lines('label a:', '', '    pass', '    "Hi."'))))

    // Several scenes, each judged on its own.
    const many = lines(
      'label a:',
      '    pass',
      '    "Words."',
      '',
      'label b:',
      '    pass',
      '',
      'label c:',
      '    "More."'
    )
    check('every scene in a file is judged separately',
      through(many) === lines(
        'label a:',
        '    "Words."',
        '',
        'label b:',
        '    pass',
        '',
        'label c:',
        '    "More."'
      ), JSON.stringify(through(many)))

    const preamble = lines('define e = Character("E")', '', 'label a:', '    "Hi."')
    check('lines above the first label are left alone', through(preamble) === preamble,
      JSON.stringify(through(preamble)))

    // The sample project, which is shaped like a real one: opening a file and
    // typing in it must not rewrite anything else in it.
    for (const file of ['script.rpy', 'chapter_1.rpy', 'chapter_2.rpy', 'chapter_10.rpy']) {
      const source = await fs.readFile(
        path.join(EPISODIC, 'game', 'scripts', file), 'utf8')
      check(`${file} is left exactly as it is`, through(source) === source)
    }

    // Untouched input comes back as the very same array, so an edit somewhere
    // else in a long file does not rebuild every node.
    const doc = parseDocument(lines('label a:', '    "Hi."'))
    check('a file needing nothing is handed straight back',
      dropSpentPass(doc.nodes) === doc.nodes)
  }

  console.log('\n[naming a character the script has never heard of]')
  {
    check('a name becomes a variable', toVarName('Mara Kowalski') === 'mara_kowalski',
      toVarName('Mara Kowalski'))
    check('an apostrophe just goes', toVarName("O'Hara") === 'ohara', toVarName("O'Hara"))
    // Folded rather than dropped: a Swedish writer gets asa, not sa.
    check('accents fold to the letter underneath', toVarName('Asa Lindqvist') === 'asa_lindqvist',
      toVarName('Asa Lindqvist'))
    check('and so do Czech ones', toVarName('Bozena Nemcova') === 'bozena_nemcova',
      toVarName('Bozena Nemcova'))
    // Nothing to fold to. Ren'Py 7 runs on Python 2, where this would not even
    // parse, so it falls back rather than writing a name that breaks the game.
    check('a name outside the Latin alphabet falls back',
      toVarName('\u85cd') === 'character', toVarName('\u85cd'))
    check('a number cannot start a variable', toVarName('3 Sisters') === 'c_3_sisters',
      toVarName('3 Sisters'))
    // define class = Character(...) is a syntax error, not a character.
    check('a Python keyword is stepped around', toVarName('Class') === 'class_',
      toVarName('Class'))
    check('a blank name still yields something usable', toVarName('   ') === 'character',
      toVarName('   '))

    check('a free name is used as it is',
      characterVarName('Mara', ['ava', 'ben']) === 'mara')
    check('a taken one is numbered',
      characterVarName('Mara', ['mara']) === 'mara_2')
    check('and keeps counting',
      characterVarName('Mara', ['mara', 'mara_2', 'mara_3']) === 'mara_4')
  }

  console.log('\n[defining a character: the file RW writes to]')
  {
    const charactersRel = 'game/characters.rpy'
    const charactersFile = path.join(SCRATCH, charactersRel)
    await fs.rm(charactersFile, { force: true })

    const first = await defineCharacter(SCRATCH, ws, 'Mara Kowalski')
    check('the definition is written', first.ok, first.reason)
    check('into game/characters.rpy', first.file === charactersRel, String(first.file))
    check('which it had to create', first.created === true, String(first.created))
    check('under a name made from theirs', first.varName === 'mara_kowalski',
      String(first.varName))

    const written = await fs.readFile(charactersFile, 'utf8')
    check('the line reads as Ren.Py expects',
      written.trim() === 'define mara_kowalski = Character("Mara Kowalski")', written.trim())
    check('and the file ends in a newline', written.endsWith(String.fromCharCode(10)), JSON.stringify(written.slice(-2)))

    // The point of all of it: the scanner now finds them.
    const cast = await scanCharacters(SCRATCH)
    const mara = cast.find((c) => c.varName === 'mara_kowalski')
    check('a scan picks the new character up', mara?.name === 'Mara Kowalski', String(mara?.name))
    check('and knows where they were written',
      mara?.sourceFile === charactersRel, String(mara?.sourceFile))

    const second = await defineCharacter(SCRATCH, ws, 'Ben Alder')
    check('a second definition appends', second.ok && second.created === false,
      String(second.reason))
    const both = await fs.readFile(charactersFile, 'utf8')
    check('without disturbing the first',
      both.includes('define mara_kowalski = Character("Mara Kowalski")') &&
      both.includes('define ben_alder = Character("Ben Alder")'), both)
    check('one definition per line',
      both.trim().split(String.fromCharCode(10)).length === 2, JSON.stringify(both))

    // ava is defined in the sample script, so a second Ava cannot be ava.
    const clash = await defineCharacter(SCRATCH, ws, 'Ava')
    check('a name already defined in the script is numbered rather than repeated',
      clash.varName === 'ava_2', String(clash.varName))

    // Wider than the cast: any define at all is a name that is taken.
    await fs.appendFile(charactersFile, 'define muriel = 3' + String.fromCharCode(10), 'utf8')
    const nonCharacter = await defineCharacter(SCRATCH, ws, 'Muriel')
    check('and so is a name bound to something that is not a character',
      nonCharacter.varName === 'muriel_2', String(nonCharacter.varName))

    const quoted = await defineCharacter(SCRATCH, ws, 'The ' + String.fromCharCode(34) + 'Doctor' + String.fromCharCode(34))
    check('a quote in the name is escaped', quoted.ok, quoted.reason)
    const backAgain = await scanCharacters(SCRATCH)
    check('so the name scans back as it was typed',
      backAgain.find((c) => c.varName === quoted.varName)?.name === 'The ' + String.fromCharCode(34) + 'Doctor' + String.fromCharCode(34),
      String(backAgain.find((c) => c.varName === quoted.varName)?.name))

    const blank = await defineCharacter(SCRATCH, ws, '   ')
    check('an empty name is refused', !blank.ok, blank.reason)
    const twoLines = await defineCharacter(SCRATCH, ws, 'Mara' + String.fromCharCode(10) + 'Kowalski')
    check('and so is one that spans lines', !twoLines.ok, twoLines.reason)

    // A project written on Windows keeps its line endings.
    await fs.writeFile(charactersFile,
      'define solo = Character("Solo")' + String.fromCharCode(13, 10), 'utf8')
    await defineCharacter(SCRATCH, ws, 'Nadia Vero')
    const windows = await fs.readFile(charactersFile, 'utf8')
    check('a CRLF file gains a CRLF line, not a stray LF',
      windows.split(String.fromCharCode(10)).every((l) => l === '' || l.endsWith(String.fromCharCode(13))), JSON.stringify(windows))

    // A file that never ended in a newline still gets a line of its own.
    await fs.writeFile(charactersFile, 'define solo = Character("Solo")', 'utf8')
    await defineCharacter(SCRATCH, ws, 'Nadia Vero')
    const joined = await fs.readFile(charactersFile, 'utf8')
    check('a file with no closing newline is not run into',
      joined.includes('("Solo")' + String.fromCharCode(10) + 'define'), JSON.stringify(joined))

    await fs.rm(charactersFile, { force: true })
  }

  console.log('\n[image resolution for scene/show]')
  const TC = EPISODIC

  // Every name the sample project actually stages.
  const chapterFiles = (await fs.readdir(path.join(TC, 'game', 'scripts')))
    .filter((f) => f.startsWith('chapter_'))
  let staged = ''
  for (const f of chapterFiles) {
    staged += await fs.readFile(path.join(TC, 'game', 'scripts', f), 'utf8')
  }
  const used = [...new Set(staged.split(String.fromCharCode(10))
    .map((l) => l.trim()).map((l) => l.match(/^\s*scene\s+([a-z0-9_ ]+?)(?:\s+(?:with|at|as|behind|onlayer|zorder)\b.*)?$/i))
    .filter(Boolean).map((m) => m![1].trim()))]
  // Only scene names map one-to-one onto image files. A `show` name resolves
  // through the portrait index, which is a different question from this one.
  check('found scene names to resolve', used.length >= 3, String(used.length))

  // A miss is expected when the render has not been made yet, so check the
  // resolver against what is actually on disk rather than a hit rate.
  const imageFiles = new Set<string>()
  const walkImages = async (dir: string): Promise<void> => {
    for (const e of await fs.readdir(dir, { withFileTypes: true })) {
      if (e.isDirectory()) await walkImages(path.join(dir, e.name))
      else imageFiles.add(e.name.replace(/[.][^.]+$/, '').toLowerCase())
    }
  }
  await walkImages(TC + '/game/images')

  const wrong: string[] = []
  for (const n of used) {
    const r = await resolveImageName(TC, n)
    const onDisk = imageFiles.has(n.toLowerCase())
    const gotSomething = !!r.dataUrl || r.kind === 'video' || r.kind === 'color'
    // A file can exist and still be overridden by an explicit declaration, so
    // only an unexplained miss counts as wrong.
    if (!onDisk && gotSomething && r.kind !== 'color') wrong.push(n + ' (resolved, not on disk)')
    if (onDisk && !gotSomething && !r.matched) wrong.push(n + ' (on disk, silently unresolved)')
  }
  check('every name resolves exactly when its file exists',
    wrong.length === 0, wrong.slice(0, 4).join('; '))
  // Deliberately not "the project still has some missing renders": that was an
  // assumption about live artwork, and it stopped holding the moment the render
  // sync filled the gaps in. The behaviour worth pinning is that a name with no
  // file resolves to nothing and says why.
  const invented = await resolveImageName(TC, 'zz_no_such_render_' + Date.now())
  check('a name with no render resolves to nothing',
    !invented.dataUrl && !invented.matched, JSON.stringify(invented).slice(0, 120))
  check('nothing is invented for it either',
    !invented.kind && !invented.color, JSON.stringify(invented))

  const one = await resolveImageName(TC, 'bg_kitchen')
  check('a scene image resolves to a data URL',
    !!one.dataUrl && one.dataUrl.startsWith('data:image/'), String(one.reason ?? one.dataUrl?.slice(0, 24)))
  check('it reports which name matched', one.matched === 'bg_kitchen', String(one.matched))

  const black = await resolveImageName(TC, 'black')
  check('an explicit colour declaration is reported as a colour',
    black.kind === 'color' && black.color === '#000', JSON.stringify(black))

  const attrs = await resolveImageName(TC, 'bg_kitchen with dissolve')
  check('trailing words fall back to a shorter name',
    attrs.matched === 'bg_kitchen', String(attrs.matched))

  const movie = await resolveImageName(TC, 'ep1_walk_anim')
  check('a Movie image is reported as video rather than inlined',
    movie.dataUrl === null && (movie.kind === 'video' || !!movie.reason),
    JSON.stringify(movie))

  const nope = await resolveImageName(TC, 'definitely_not_an_image_xyz')
  check('an unknown name resolves to nothing', nope.dataUrl === null && !nope.matched)
  check('an empty name is safe', (await resolveImageName(TC, '   ')).dataUrl === null)

  const portrait = await readPortrait(TC, 'portraits/ava_happy.png')
  check('portraits still resolve through the shared index',
    !!portrait && portrait.startsWith('data:image/png'), String(portrait?.slice(0, 20)))

  {

  console.log('\n[image hover: finding the name under the pointer]')
  const nameAt = (line: string, col: number) => imageNameAt(line, 0, col)
  const scene = '    scene ch9_diner_1 with Fade(1, 1, 2)'
  const hit = nameAt(scene, 12)
  check('finds the name after scene', hit?.name === 'ch9_diner_1', JSON.stringify(hit))
  check('the span covers just the name',
    hit !== null && scene.slice(hit.from, hit.to) === 'ch9_diner_1',
    hit ? scene.slice(hit.from, hit.to) : 'none')
  check('stops before the with clause', nameAt(scene, 32) === null, JSON.stringify(nameAt(scene, 32)))
  check('nothing before the name', nameAt(scene, 6) === null)

  const show = '    show nadia happy at left'
  const s2 = nameAt(show, 16)
  check('keeps attributes as part of the name', s2?.name === 'nadia happy', JSON.stringify(s2))
  check('stops before at', nameAt(show, 25) === null)

  check('ignores dialogue lines', nameAt('    omar "Kde se flaka?"', 10) === null)
  check('ignores a bare scene', nameAt('    scene', 8) === null)
  check('handles no indentation', nameAt('scene black', 8)?.name === 'black')
  check('handles extra spacing', nameAt('  scene   x_1   with dissolve', 12)?.name === 'x_1',
    JSON.stringify(nameAt('  scene   x_1   with dissolve', 12)))
  }

  console.log('\n[restructure: moving beats between files]')
  {
    const L = String.fromCharCode(10)
    const mk = (...ls: string[]) => ls.join(L) + L

    // Three labels, all explicitly jumping onward.
    const linked = mk(
      'label A:', '    a "one"', '    jump B', '',
      'label B:', '    b "two"', '    jump C', '',
      'label C:', '    c "three"', '    return'
    )

    const within = moveBeat({ source: linked, target: null, label: 'C', toIndex: 0, linear: false })
    check('the block moves to the front',
      within.source.indexOf('label C:') < within.source.indexOf('label A:'),
      within.source.slice(0, 40))
    check('the moved block keeps its body', within.source.includes('c "three"'))
    check('every label survives the move',
      ['A', 'B', 'C'].every((n) => within.source.includes('label ' + n + ':')))
    check('non-linear leaves existing jumps alone',
      within.source.includes('jump B') && within.source.includes('jump C'))

    const relinked = moveBeat({ source: linked, target: null, label: 'C', toIndex: 0, linear: true })
    const order = ['A', 'B', 'C'].map((n) => relinked.source.indexOf('label ' + n + ':'))
    check('linear reorders the file', order[2] < order[0] && order[0] < order[1],
      JSON.stringify(order))
    check('linear refuses to rewrite a return', /label C:[\s\S]*?return/.test(relinked.source),
      'C should still end in return')
    check('and says why the order could not be applied',
      relinked.warnings.some((w) => w.includes('C') && w.includes('control flow')),
      JSON.stringify(relinked.warnings))
    check('linear points A at B', /label A:[\s\S]*?jump B/.test(relinked.source), 'no A->B')
    check('linear leaves the last label alone', relinked.source.includes('return'))

    // Fall-through must become explicit before anything moves.
    const falls = mk(
      'label A:', '    a "one"', '',
      'label B:', '    b "two"', '',
      'label C:', '    c "three"'
    )
    const moved = moveBeat({ source: falls, target: null, label: 'B', toIndex: 2, linear: false })
    check('a moved fall-through is written out as a jump',
      /label B:[\s\S]*?jump C/.test(moved.source), moved.source)
    check('the former predecessor also gets an explicit jump',
      /label A:[\s\S]*?jump B/.test(moved.source), moved.source)
    check('the materialised jumps are reported', moved.materialised.length >= 2,
      JSON.stringify(moved.materialised))
    check('story order is unchanged despite the new file order',
      moved.source.indexOf('label C:') < moved.source.indexOf('label B:'),
      'B should now sit after C in the file')

    // Across two files.
    const epOne = mk('label A:', '    a "one"', '    jump B', '', 'label B:', '    b "two"', '    return')
    const epTwo = mk('label X:', '    x "hello"', '    return')
    const across = moveBeat({ source: epOne, target: epTwo, label: 'B', toIndex: -1, linear: false })
    check('the beat leaves the source file', !across.source.includes('label B:'), across.source)
    check('the beat arrives in the target file', across.target.includes('label B:'))
    check('its body travels with it', across.target.includes('b "two"'))
    check('the source keeps its other label', across.source.includes('label A:'))
    check('the target keeps its own label', across.target.includes('label X:'))
    check('a jump into the moved beat still points at it, across files',
      across.source.includes('jump B'), across.source)
    check('a blank line separates appended blocks',
      /return\s*\n\s*\n\s*label B:/.test(across.target), JSON.stringify(across.target))

    // Inserting in the middle of the target materialises the new predecessor.
    const epThree = mk('label X:', '    x "hi"', '', 'label Y:', '    y "yo"')
    const middle = moveBeat({ source: epOne, target: epThree, label: 'B', toIndex: 1, linear: false })
    check('the beat lands between the target labels',
      middle.target.indexOf('label X:') < middle.target.indexOf('label B:') &&
      middle.target.indexOf('label B:') < middle.target.indexOf('label Y:'),
      middle.target)
    check('the label it was inserted after gets an explicit jump',
      /label X:[\s\S]*?jump Y/.test(middle.target), middle.target)

    // Guards and edge cases.
    const missing = moveBeat({ source: epOne, target: null, label: 'NOPE', toIndex: 0, linear: false })
    check('an unknown label is refused', !!missing.error, String(missing.error))
    check('a refused move changes nothing', missing.source === epOne)

    const single = mk('label ONLY:', '    a "x"', '    return')
    const noop = moveBeat({ source: single, target: null, label: 'ONLY', toIndex: 0, linear: true })
    check('moving the only label is harmless', noop.source.includes('label ONLY:'), noop.source)

    const crlf = 'label A:\r\n    a "one"\r\n    jump B\r\n\r\nlabel B:\r\n    b "two"\r\n'
    const crlfMoved = moveBeat({ source: crlf, target: null, label: 'B', toIndex: 0, linear: false })
    check('CRLF files stay CRLF',
      !/[^\r]\n/.test(crlfMoved.source), JSON.stringify(crlfMoved.source))

    // Hand-authored endings are never rewritten.
    const branchy = mk(
      'label A:', '    menu:', '        "go":', '            jump B', '',
      'label B:', '    b "two"', '    jump C', '',
      'label C:', '    c "three"', '    return'
    )
    const branchMoved = moveBeat({ source: branchy, target: null, label: 'C', toIndex: 1, linear: true })
    check('a menu ending is left untouched', branchMoved.source.includes('menu:') &&
      branchMoved.source.includes('"go":'), branchMoved.source)
    check('the menu label gains no trailing jump',
      !/jump B\s*\n\s*\n\s*label/.test(branchMoved.source.split('label B:')[0].replace('            jump B', '')),
      'unexpected jump added after the menu')
  }

  console.log('\n[translation: deciding what needs translating]')
  {
    // Real lines from chapter_9_2.
    const czech = [
      'Kde se fláká?',
      'Možná usnul na záchodě.',
      'Prej přijde za chvilku, je mu blbě.',
      'Nic nevydrží...',
      'Neměla bych jít za ním?'
    ]
    const english = [
      "Answer me. And no bullshit.",
      'You... killed him?',
      'I had no idea. Dave mi nic neřekl.',
      "That's a big knife you've got there.",
      'I know, it was hard-'
    ]
    check('Czech lines are marked for translation',
      czech.every((l) => classifyLine(l) === 'source'),
      JSON.stringify(czech.map(classifyLine)))
    check('English lines are left alone',
      english.slice(0, 2).concat(english.slice(3)).every((l) => classifyLine(l) === 'target'),
      JSON.stringify(english.map(classifyLine)))
    check('a mixed line counts as needing work', classifyLine(english[2]) === 'source',
      classifyLine(english[2]))

    check('diacritics settle it on their own', classifyLine('Ano') === 'unknown' &&
      classifyLine('Ano, jsem tady') === 'source', classifyLine('Ano, jsem tady'))
    check('markup is ignored when classifying',
      classifyLine('{i}Nejsem na to hrdej{/i}') === 'source',
      classifyLine('{i}Nejsem na to hrdej{/i}'))
    check('interpolation is ignored when classifying',
      classifyLine('Hello [player_name], how are you?') === 'target',
      classifyLine('Hello [player_name], how are you?'))
    check('an empty line needs nothing', classifyLine('   ') === 'target')
    check('markup-only needs nothing', classifyLine('{w=1.0}') === 'target')
    check('needsTranslation follows the classification',
      needsTranslation('Kde se fláká?') && !needsTranslation('What are you doing?'))
  }

  console.log('\n[translation: the prompt]')
  {
    const units = [
      { id: 1, text: 'Kde se fláká?', speaker: 'Omar', accent: 'Ghetto' },
      { id: 2, text: 'Ano.', speaker: 'Nadia' },
      { id: 3, text: 'Odejít', speaker: null, isChoice: true }
    ]
    const prompt = buildPrompt(units, 'cs', 'en')
    check('the prompt names both languages', prompt.includes('cs') && prompt.includes('en'))
    check('a character accent is passed through', prompt.includes('Omar: Ghetto'), prompt)
    check('a character with no accent adds no voice line', !prompt.includes('Nadia:'))
    check('choices are marked as choices', prompt.includes('CHOICE'))
    check('narrator lines are labelled', buildPrompt(
      [{ id: 1, text: 'x', speaker: null }], 'cs', 'en').includes('NARRATOR'))
    check('markup preservation is demanded', prompt.includes('{i}'))
    check('every line is carried with its id',
      units.every((u) => prompt.includes('"id":' + u.id)), prompt)

    const good = parseResponse('{"translations":[{"id":1,"text":"Where is he?"}]}')
    check('a clean reply parses', good.byId.get(1) === 'Where is he?')
    const fenced = parseResponse('Sure!\n```json\n{"translations":[{"id":2,"text":"Yes."}]}\n```')
    check('a fenced reply with preamble parses', fenced.byId.get(2) === 'Yes.', JSON.stringify(fenced))
    const braces = parseResponse('{"translations":[{"id":3,"text":"a } brace in a string"}]}')
    check('braces inside strings do not confuse it',
      braces.byId.get(3) === 'a } brace in a string', JSON.stringify(braces))
    check('a reply with no JSON is reported', !!parseResponse('I cannot do that').error)
    check('malformed JSON is reported', !!parseResponse('{"translations": [').error)
    check('a reply with no translations is reported', !!parseResponse('{"other":1}').error)
  }

  console.log('\n[translation: applying results to a script]')
  {
    const L = String.fromCharCode(10)
    const script = [
      'label D17_TEST:',
      '    # Omar is on the bed',
      '    scene bg_kitchen',
      '    omar "Kde se fláká?"',
      '    nadia "Answer me. And no bullshit."',
      '    omar serious "{i}Nejsem na to hrdej{/i}, ale uz me to sralo."',
      '    "Narrator line, ktera je ceska."',
      '    menu:',
      '        "Odejit":',
      '            jump SOMEWHERE',
      '    return',
      ''
    ].join(L)

    let sent = ''
    const fake = async (prompt) => {
      sent = prompt
      const ids = [...prompt.matchAll(/"id":(\d+)/g)].map((m) => Number(m[1]))
      const texts = [...prompt.matchAll(/"text":("(?:[^"\\]|\\.)*")/g)].map((m) => JSON.parse(m[1]))
      return {
        ok: true,
        output: JSON.stringify({
          translations: ids.map((id, i) => ({ id, text: 'EN<' + texts[i] + '>' }))
        })
      }
    }

    const cast = [
      { varName: 'omar', name: 'Omar', expressions: [], portraits: {} },
      { varName: 'nadia', name: 'Nadia', expressions: [], portraits: {} }
    ]
    const profiles = [
      { id: 'p1', varNames: ['omar'], name: 'Omar', accent: 'Ghetto' }
    ]

    const result = await runPass(script,
      { mode: 'translate' as const, sourceLanguage: 'cs', targetLanguage: 'en', cast, profiles }, fake)

    check('the already-English line was skipped', result.skipped === 1, String(result.skipped))
    check('the English line is untouched in the output',
      result.content.includes('nadia "Answer me. And no bullshit."'), result.content)
    check('Czech dialogue was translated',
      result.content.includes('omar "EN<Kde se fláká?>"'), result.content)
    check('a narrator line was translated',
      result.content.includes('"EN<Narrator line, ktera je ceska.>"'))
    check('a menu choice was translated',
      result.content.includes('"EN<Odejit>":'), result.content)
    check('the expression attribute survived',
      /omar serious "EN</.test(result.content), result.content)
    check('comments are not translated', result.content.includes('# Omar is on the bed'))
    check('code lines are untouched',
      result.content.includes('scene bg_kitchen') &&
      result.content.includes('jump SOMEWHERE') &&
      result.content.includes('label D17_TEST:'))
    check('the speaker accent reached the prompt', sent.includes('Omar: Ghetto'), sent.slice(0, 200))
    check('changes are reported with before and after',
      result.changes.length === 4 &&
      result.changes.every((c) => c.before && c.after && c.line > 0),
      JSON.stringify(result.changes.map((c) => c.line)))
    check('the line numbers point at the right lines',
      result.changes[0].line === 4, JSON.stringify(result.changes[0]))

    // Restricting to a selection.
    const partial = await runPass(script,
      { mode: 'translate' as const, sourceLanguage: 'cs', targetLanguage: 'en', cast, profiles, lines: [4] }, fake)
    check('a line restriction limits what is sent', partial.changes.length === 1,
      JSON.stringify(partial.changes.map((c) => c.line)))
    check('lines outside the selection are untouched',
      partial.content.includes('"Narrator line, ktera je ceska."'), partial.content)

    // A failing runner must not touch the script.
    const failing = async () => ({ ok: false, output: '', error: 'CLI not found' })
    const failed = await runPass(script,
      { mode: 'translate' as const, sourceLanguage: 'cs', targetLanguage: 'en', cast, profiles }, failing)
    check('a failed run reports the error', failed.error === 'CLI not found', String(failed.error))
    check('a failed run leaves the script alone', failed.content === script)

    // A reply missing some ids applies only what came back.
    const partialReply = async () => ({
      ok: true, output: '{"translations":[{"id":1,"text":"Only this one"}]}'
    })
    const some = await runPass(script,
      { mode: 'translate' as const, sourceLanguage: 'cs', targetLanguage: 'en', cast, profiles }, partialReply)
    check('a partial reply applies only what it returned', some.changes.length === 1,
      JSON.stringify(some.changes.map((c) => c.after)))
    check('the untranslated lines keep their original text',
      some.content.includes('"Narrator line, ktera je ceska."'))

    // Nothing to do.
    const englishOnly = 'label X:' + L + '    a "Hello there."' + L
    const nothing = await runPass(englishOnly,
      { mode: 'translate' as const, sourceLanguage: 'cs', targetLanguage: 'en', cast, profiles }, fake)
    check('an all-English script is left alone', nothing.content === englishOnly &&
      nothing.changes.length === 0, String(nothing.changes.length))

    // Batching.
    let calls = 0
    const counting = async (prompt) => {
      calls++
      const ids = [...prompt.matchAll(/"id":(\d+)/g)].map((m) => Number(m[1]))
      return { ok: true, output: JSON.stringify({ translations: ids.map((id) => ({ id, text: 'x' })) }) }
    }
    const many = 'label Y:' + L +
      Array.from({ length: 7 }, (_, i) => '    a "Ceska veta cislo ' + i + ', jsem tady."').join(L) + L
    await runPass(many,
      { mode: 'translate' as const, sourceLanguage: 'cs', targetLanguage: 'en', cast, profiles, batchSize: 3 }, counting)
    check('long scripts are sent in batches', calls === 3, String(calls))
  }

  console.log('\n[accounts and sessions]')
  {
    const os = await import('node:os')
    const fsp = (await import('node:fs')).promises
    const nodePath = await import('node:path')

    const dir = nodePath.join(os.tmpdir(), 'rpw-auth-' + Date.now())
    await fsp.mkdir(dir, { recursive: true })
    const users = createUserStore(dir)
    const sessions = createSessionStore(dir)

    check('a fresh installation has no accounts', (await users.count()) === 0)

    const admin = await users.create({
      username: 'Jan', password: 'correct horse battery', role: 'admin'
    })
    check('a username is stored lowercase', admin.username === 'jan', admin.username)
    check('the account has a role', admin.role === 'admin', admin.role)

    const stored = JSON.parse(await fsp.readFile(nodePath.join(dir, 'users.json'), 'utf8'))
    check('the password itself is never written',
      !JSON.stringify(stored).includes('correct horse battery'),
      JSON.stringify(stored).slice(0, 80))
    check('what is written is a salt and a hash',
      !!stored.users[0].salt && !!stored.users[0].hash && stored.users[0].hash.length > 20)
    check('two accounts with the same password get different hashes',
      (await users.create({ username: 'ada', password: 'correct horse battery', role: 'writer' })) &&
      (await (async () => {
        const both = JSON.parse(await fsp.readFile(nodePath.join(dir, 'users.json'), 'utf8'))
        return both.users[0].hash !== both.users[1].hash
      })()))

    check('the right password is accepted',
      (await users.verify('jan', 'correct horse battery'))?.id === admin.id)
    check('the name is matched regardless of case',
      (await users.verify('JAN', 'correct horse battery'))?.id === admin.id)
    check('a wrong password is refused',
      (await users.verify('jan', 'correct horse batteru')) === null)
    check('an unknown account is refused',
      (await users.verify('nobody', 'correct horse battery')) === null)
    check('an empty password is refused', (await users.verify('jan', '')) === null)

    const short = await users.create({ username: 'x', password: 'short', role: 'viewer' })
      .then(() => null, (e) => e.message)
    check('a short password is refused with a reason',
      (short ?? '').includes('12 characters'), String(short))

    const duplicate = await users.create({
      username: 'jan', password: 'another long password', role: 'writer'
    }).then(() => null, (e) => e.message)
    check('a duplicate username is refused', (duplicate ?? '').includes('already an account'),
      String(duplicate))

    const lastAdmin = await users.remove(admin.id).then(() => null, (e) => e.message)
    check('the only administrator cannot be removed',
      (lastAdmin ?? '').includes('only administrator'), String(lastAdmin))

    // Sessions.
    const session = await sessions.create(admin.id)
    check('a session id is long and random', session.id.length >= 40, String(session.id.length))
    check('a session can be looked up', (await sessions.get(session.id))?.userId === admin.id)
    check('an invented session is not found', (await sessions.get('made-up')) === null)
    check('an empty session id is not found', (await sessions.get('')) === null)

    await sessions.destroy(session.id)
    check('signing out ends the session', (await sessions.get(session.id)) === null)

    const expired = await sessions.create(admin.id)
    const raw = JSON.parse(await fsp.readFile(nodePath.join(dir, 'sessions.json'), 'utf8'))
    raw.sessions[0].expiresAt = Date.now() - 1000
    await fsp.writeFile(nodePath.join(dir, 'sessions.json'), JSON.stringify(raw), 'utf8')
    check('an expired session is not accepted', (await sessions.get(expired.id)) === null)

    await fsp.rm(dir, { recursive: true, force: true })
  }

  console.log('\n[who may do what]')
  {
    const asRole = (role) => ({ id: 'u', username: 'u', role, createdAt: '' })

    check('reading is allowed for everyone',
      ['admin', 'writer', 'proofreader', 'viewer']
        .every((r) => mayPerform(asRole(r), IPC.readEpisode)))
    check('an admin may write', mayPerform(asRole('admin'), IPC.writeEpisode))
    check('a writer may write', mayPerform(asRole('writer'), IPC.writeEpisode))
    check('a proofreader may not write yet', !mayPerform(asRole('proofreader'), IPC.writeEpisode))
    check('a viewer may not write', !mayPerform(asRole('viewer'), IPC.writeEpisode))
    check('a proofreader is told what is coming instead of just refused',
      refusalFor(asRole('proofreader'), IPC.writeEpisode).includes('Suggestions'),
      refusalFor(asRole('proofreader'), IPC.writeEpisode))

    check('committing counts as writing', isWrite(IPC.gitCommit))
    check('translating counts as writing', isWrite(IPC.runScriptPass))
    check('moving a beat counts as writing', isWrite(IPC.moveBeat))
    check('reading a script does not', !isWrite(IPC.readEpisode))
    check('reading git status does not', !isWrite(IPC.gitStatus))

    // Every operation is either named a write or is a read on purpose; this
    // catches a new one being added and silently treated as readable.
    // Operations that only look at things, whose names happen to read like
    // changes. Listed rather than pattern-matched around, so adding one is a
    // deliberate act.
    const readsThatSoundLikeWrites = new Set<string>([IPC.planRemoveBeat, IPC.planRenderSync])
    const unclassified = Object.values(IPC).filter(
      (channel) =>
        !isWrite(channel) &&
        !readsThatSoundLikeWrites.has(channel) &&
        /write|create|update|set|move|remove|commit|push|pull|convert|rename|pass/i.test(channel)
    )
    check('no changing operation is left unclassified', unclassified.length === 0,
      JSON.stringify(unclassified))
  }

  console.log('\n[slowing down guessing]')
  {
    const limiter = createAttemptLimiter({ max: 3, windowMs: 60000 })
    check('the first attempt is allowed', limiter.check('a').allowed)
    limiter.fail('a')
    limiter.fail('a')
    check('a couple of failures are still allowed', limiter.check('a').allowed)
    limiter.fail('a')
    check('too many failures are stopped', !limiter.check('a').allowed)
    check('and it says when to try again', (limiter.check('a').retryInSeconds ?? 0) > 0,
      String(limiter.check('a').retryInSeconds))
    check('a different account is unaffected', limiter.check('b').allowed)
    limiter.succeed('a')
    check('signing in clears the count', limiter.check('a').allowed)
  }

  console.log('\n[cookies]')
  {
    const cookie = sessionCookie('abc123', true)
    check('the cookie is not readable from script', cookie.includes('HttpOnly'), cookie)
    check('it is not sent on requests other sites start',
      cookie.includes('SameSite=Strict'), cookie)
    check('it is marked secure behind HTTPS', cookie.includes('Secure'), cookie)
    check('and not marked secure on plain loopback',
      !sessionCookie('abc123', false).includes('Secure'), sessionCookie('abc123', false))
    check('clearing it expires it immediately',
      clearedCookie(false).includes('Max-Age=0'), clearedCookie(false))

    const req = (cookies?: string, origin?: string, host?: string) =>
      ({ headers: { cookie: cookies, origin, host } }) as never
    check('a cookie is read out of a header',
      readCookie(req('a=1; rpw_session=xyz; b=2'), 'rpw_session') === 'xyz')
    check('a missing cookie reads as nothing',
      readCookie(req('a=1'), 'rpw_session') === null)
    check('no cookie header at all reads as nothing',
      readCookie(req(undefined), 'rpw_session') === null)

    check('a request from the same origin is allowed',
      originAllowed(req(undefined, 'https://write.example', 'write.example')))
    check('a request from another site is refused',
      !originAllowed(req(undefined, 'https://evil.example', 'write.example')))
    check('a request with no origin is allowed, since the cookie rules still apply',
      originAllowed(req(undefined, undefined, 'write.example')))
    check('a malformed origin is refused',
      !originAllowed(req(undefined, 'not a url', 'write.example')))

    // A Secure cookie never comes back over plain HTTP, so the server has to
    // know which it was: otherwise signing in looks fine and then does nothing.
    const overHttp = { socket: {}, headers: {} } as never
    const overTls = { socket: { encrypted: true }, headers: {} } as never
    const behindProxy = { socket: {}, headers: { 'x-forwarded-proto': 'https' } } as never
    const proxyChain = { socket: {}, headers: { 'x-forwarded-proto': 'https, http' } } as never
    check('a plain connection is not mistaken for HTTPS', !arrivedOverHttps(overHttp))
    check('a TLS connection is recognised', arrivedOverHttps(overTls))
    check('so is one a proxy vouches for', arrivedOverHttps(behindProxy))
    check('and only the first hop of a chain counts', arrivedOverHttps(proxyChain))
    check('a proxy reporting plain http is not HTTPS',
      !arrivedOverHttps({ socket: {}, headers: { 'x-forwarded-proto': 'http' } } as never))
  }

  console.log('\n[git sync]')
  {
    const os = await import('node:os')
    const fsp = (await import('node:fs')).promises
    const nodePath = await import('node:path')
    const { spawn } = await import('node:child_process')

    const git = (cwd: string, args: string[]) =>
      new Promise<number>((resolve) => {
        const child = spawn('git', args, { cwd, stdio: 'ignore' })
        child.on('error', () => resolve(-1))
        child.on('close', (code) => resolve(code ?? -1))
      })

    const base = nodePath.join(os.tmpdir(), 'rpw-git-' + Date.now())
    const remote = nodePath.join(base, 'remote.git')
    const nadia = nodePath.join(base, 'nadia')
    const bob = nodePath.join(base, 'bob')
    await fsp.mkdir(base, { recursive: true })

    const available = (await git(base, ['--version'])) === 0
    check('git is available to test against', available)

    if (available) {
      await git(base, ['init', '--bare', '--initial-branch=main', remote])
      await git(base, ['clone', '--quiet', remote, nadia])
      const identify = async (dir: string, who: string) => {
        await git(dir, ['config', 'user.name', who])
        await git(dir, ['config', 'user.email', who + '@example.com'])
      }
      await identify(nadia, 'nadia')

      // A project shaped like the real one.
      await fsp.mkdir(nodePath.join(nadia, 'game', 'scripts'), { recursive: true })
      await fsp.mkdir(nodePath.join(nadia, 'game', 'images', 'ch1'), { recursive: true })
      await fsp.mkdir(nodePath.join(nadia, '.renpywriter'), { recursive: true })
      const L = String.fromCharCode(10)
      await fsp.writeFile(nodePath.join(nadia, 'game', 'scripts', 'chapter_1.rpy'),
        'label start:' + L + '    "Hello."' + L)
      await fsp.writeFile(nodePath.join(nadia, '.renpywriter', 'project.json'), '{}')
      await fsp.writeFile(nodePath.join(nadia, 'game', 'images', 'ch1', 'shot.webp'), 'not really')

      const fresh = await readStatus(nadia)
      check('a new file shows as untracked', fresh.changes.length === 3 &&
        fresh.changes.every((c) => c.state === 'untracked'),
        JSON.stringify(fresh.changes))
      check('changes are grouped by what they are',
        fresh.changes.find((c) => c.path.endsWith('.rpy'))?.group === 'script' &&
        fresh.changes.find((c) => c.path.endsWith('.webp'))?.group === 'image' &&
        fresh.changes.find((c) => c.path.startsWith('.renpywriter'))?.group === 'reference',
        JSON.stringify(fresh.changes.map((c) => c.path + ':' + c.group)))
      check('the branch and its remote are reported',
        fresh.isRepo && fresh.branch === 'main', JSON.stringify({ branch: fresh.branch }))
      check('the identity is picked up', fresh.identity.name === 'nadia',
        JSON.stringify(fresh.identity))

      // Only what is named gets committed.
      const partial = await commit(nadia, {
        message: 'First scene',
        paths: ['game/scripts/chapter_1.rpy']
      })
      check('committing succeeds', partial.ok, partial.message + ' ' + (partial.detail ?? ''))
      const afterPartial = await readStatus(nadia)
      check('only the named file was committed',
        afterPartial.changes.length === 2 &&
        afterPartial.changes.every((c) => c.path !== 'game/scripts/chapter_1.rpy'),
        JSON.stringify(afterPartial.changes.map((c) => c.path)))
      // Ahead/behind only mean anything once the remote branch exists, which
      // it does not in a freshly cloned empty repository.
      check('nothing is claimed about a remote branch that does not exist yet',
        afterPartial.ahead === 0 && afterPartial.behind === 0,
        afterPartial.ahead + '/' + afterPartial.behind)

      const pushed = await commit(nadia, {
        message: 'Notes and art',
        paths: ['.renpywriter/project.json', 'game/images/ch1/shot.webp'],
        push: true
      })
      check('committing and pushing succeeds', pushed.ok, pushed.message + ' ' + (pushed.detail ?? ''))
      check('the push is reported as sent', pushed.message.includes('Sent 2 commits to origin'),
        pushed.message)

      // With the branch established on the remote, ahead becomes meaningful.
      const L2 = String.fromCharCode(10)
      await fsp.writeFile(nodePath.join(nadia, 'game', 'scripts', 'chapter_0.rpy'),
        'label zero:' + L2)
      await commit(nadia, { message: 'Held back', paths: ['game/scripts/chapter_0.rpy'] })
      const held = await readStatus(nadia)
      check('a commit that has not been sent shows as ahead', held.ahead === 1, String(held.ahead))
      check('and is not mistaken for work already up for review',
        held.awaitingReview === null, String(held.awaitingReview))
      check('and names the branch it would go to', held.upstream === 'origin/main',
        String(held.upstream))
      // A commit already recorded can be sent on its own, without inventing
      // another commit to carry it.
      const sending = await push(nadia)
      check('a stranded commit can be sent by itself',
        sending.ok && sending.message.includes('Sent 1 commit'), sending.message)
      const sent = await readStatus(nadia)
      check('after sending, nothing is left ahead', sent.ahead === 0, String(sent.ahead))
      check('sending again has nothing to do', (await push(nadia)).message === 'Nothing to send.',
        (await push(nadia)).message)

      // Reading the status locally cannot know about work somebody else has
      // sent; only asking the remote can. The panel shows the first number
      // instantly and corrects it with the second, so both have to be right.
      const watcher = nodePath.join(base, 'watcher')
      await git(base, ['clone', '--quiet', remote, watcher])
      await identify(watcher, 'watcher')

      await fsp.writeFile(nodePath.join(nadia, 'game', 'scripts', 'chapter_later.rpy'),
        'label later:' + L + '    "Something new."' + L)
      await commit(nadia, {
        message: 'Sent while the other one was not looking',
        paths: ['game/scripts/chapter_later.rpy'],
        push: true
      })

      const unaware = await readStatus(watcher)
      check('reading locally does not notice what arrived',
        unaware.behind === 0, String(unaware.behind))
      const aware = await fetchStatus(watcher)
      check('asking the remote does', aware.behind === 1, String(aware.behind))
      check('and it is otherwise the same answer',
        aware.branch === unaware.branch && aware.upstream === unaware.upstream,
        JSON.stringify({ branch: aware.branch, upstream: aware.upstream }))

      // Offline is a reason to show what is known, not to show nothing.
      await git(watcher, ['remote', 'set-url', 'origin', nodePath.join(base, 'nowhere.git')])
      const offline = await fetchStatus(watcher)
      check('a remote that cannot be reached still reports the branch',
        offline.isRepo && offline.branch === aware.branch, JSON.stringify(offline.error))
      check('and does not report an error for being offline',
        offline.error === undefined, String(offline.error))
      await git(watcher, ['remote', 'set-url', 'origin', remote])

      // The second machine gets everything, images included.
      await git(base, ['clone', '--quiet', remote, bob])
      await identify(bob, 'bob')
      const bobHasImage = await fsp
        .readFile(nodePath.join(bob, 'game', 'images', 'ch1', 'shot.webp'), 'utf8')
        .catch(() => null)
      check('the other machine receives the images too', bobHasImage === 'not really',
        String(bobHasImage))
      const bobHasScript = await fsp
        .readFile(nodePath.join(bob, 'game', 'scripts', 'chapter_1.rpy'), 'utf8')
        .catch(() => null)
      check('and the scripts', (bobHasScript ?? '').includes('Hello.'), String(bobHasScript))

      // A change on one machine reaches the other.
      await fsp.writeFile(nodePath.join(nadia, 'game', 'scripts', 'chapter_1.rpy'),
        'label start:' + L + '    "Hello there."' + L)
      await commit(nadia, { message: 'Reword', paths: ['game/scripts/chapter_1.rpy'], push: true })

      const bobBefore = await readStatus(bob)
      check('the other machine does not know yet', bobBefore.behind === 0, String(bobBefore.behind))
      const pulled = await pull(bob)
      check('pulling reports what arrived', pulled.ok && pulled.message.includes('Pulled 1'),
        pulled.message)
      const bobAfter = await fsp.readFile(
        nodePath.join(bob, 'game', 'scripts', 'chapter_1.rpy'), 'utf8')
      check('and the file is updated', bobAfter.includes('Hello there.'), bobAfter)
      check('a second pull has nothing to do',
        (await pull(bob)).message === 'Already up to date.', (await pull(bob)).message)

      // Divergence is reported, never resolved behind the writer's back.
      await fsp.writeFile(nodePath.join(nadia, 'game', 'scripts', 'chapter_1.rpy'),
        'label start:' + L + '    "Nadia wrote this."' + L)
      await commit(nadia, { message: 'Nadia', paths: ['game/scripts/chapter_1.rpy'], push: true })
      await fsp.writeFile(nodePath.join(bob, 'game', 'scripts', 'chapter_1.rpy'),
        'label start:' + L + '    "Bob wrote this."' + L)
      await commit(bob, { message: 'Bob', paths: ['game/scripts/chapter_1.rpy'] })

      const diverged = await pull(bob)
      check('a divergence is refused, not merged silently', !diverged.ok, diverged.message)
      check('and offers the disagreement rather than a git lecture',
        (diverged.conflicts ?? []).length === 1, diverged.message)
      check('and says nothing has been changed yet',
        diverged.message.includes('Nothing has been changed yet'), diverged.message)
      check('and counts in words that agree with the number',
        diverged.message.includes('1 line was') && !diverged.message.includes('1 lines'),
        diverged.message)
      check('and git own terminal advice is not passed on',
        !/hint:/i.test((diverged.detail ?? '')), String(diverged.detail))
      check('and never mentions rebasing at anybody',
        !/rebase|fast-forward/i.test(diverged.message + (diverged.detail ?? '')),
        diverged.message + ' | ' + (diverged.detail ?? ''))
      const stillBob = await fsp.readFile(
        nodePath.join(bob, 'game', 'scripts', 'chapter_1.rpy'), 'utf8')
      check('the refused pull changed nothing on disk',
        stillBob.includes('Bob wrote this.'), stillBob)

      // Unsaved work in the way used to be refused, and refused with the
      // wrong reason. It is now handled instead, so what is checked here is
      // that it is not mistaken for divergence and that the work survives.
      const carl = nodePath.join(base, 'carl')
      await git(base, ['clone', '--quiet', remote, carl])
      await identify(carl, 'carl')
      const L4 = String.fromCharCode(10)
      await fsp.writeFile(nodePath.join(nadia, 'game', 'scripts', 'chapter_1.rpy'),
        'label start:' + L4 + '    "Nadia again."' + L4)
      await commit(nadia, { message: 'ahead', paths: ['game/scripts/chapter_1.rpy'], push: true })
      // Carl has an unsaved edit to the very file that is about to arrive.
      await fsp.writeFile(nodePath.join(carl, 'game', 'scripts', 'chapter_1.rpy'),
        'label start:' + L4 + '    "Carl was here."' + L4)

      const blocked = await pull(carl)
      check('the same line changed twice is a decision, not an error', !blocked.ok,
        blocked.message)
      check('and is never blamed on divergence',
        !blocked.message.includes('different starting point'), blocked.message)
      check('and promises what it delivered: nothing changed',
        blocked.message.includes('Nothing has been changed yet'), blocked.message)
      const carlKept = await fsp.readFile(
        nodePath.join(carl, 'game', 'scripts', 'chapter_1.rpy'), 'utf8')
      check('and the unsaved work is still there', carlKept.includes('Carl was here.'), carlKept)

      // Guards.
      const noMessage = await commit(bob, { message: '   ', paths: ['game/scripts/chapter_1.rpy'] })
      check('a commit without a message is refused',
        !noMessage.ok && noMessage.message.includes('needs a message'), noMessage.message)
      const nothing = await commit(bob, { message: 'x', paths: [] })
      check('a commit with nothing selected is refused',
        !nothing.ok && nothing.message.includes('Nothing selected'), nothing.message)

      const nameless = nodePath.join(base, 'nameless')
      await git(base, ['clone', '--quiet', remote, nameless])
      await git(nameless, ['config', '--unset', 'user.name'])
      await git(nameless, ['config', '--unset', 'user.email'])
      await fsp.writeFile(nodePath.join(nameless, 'new.txt'), 'x')
      const anon = await commit(nameless, { message: 'x', paths: ['new.txt'] })
      check('a missing git identity is explained rather than thrown',
        !anon.ok && anon.message.includes('does not know who you are'), anon.message)

      // One checkout, two people: a commit says who actually made it.
      const L3 = String.fromCharCode(10)
      await fsp.writeFile(nodePath.join(nadia, 'game', 'scripts', 'shared.rpy'), 'label s:' + L3)
      const attributed = await commit(nadia, {
        message: 'On behalf of somebody else',
        paths: ['game/scripts/shared.rpy'],
        author: { name: 'pat', email: 'pat@example.com' }
      })
      check('a commit can be made on behalf of a person', attributed.ok,
        attributed.message + ' ' + (attributed.detail ?? ''))

      const author = await new Promise<string>((resolve) => {
        const child = spawn('git', ['log', '-1', '--format=%an <%ae>'], {
          cwd: nadia, stdio: ['ignore', 'pipe', 'ignore']
        })
        let out = ''
        child.stdout.on('data', (d) => (out += String(d)))
        child.on('close', () => resolve(out.trim()))
        child.on('error', () => resolve(''))
      })
      check('history records that person, not the checkout',
        author === 'pat <pat@example.com>', author)

      const committer = await new Promise<string>((resolve) => {
        const child = spawn('git', ['log', '-1', '--format=%cn'], {
          cwd: nadia, stdio: ['ignore', 'pipe', 'ignore']
        })
        let out = ''
        child.stdout.on('data', (d) => (out += String(d)))
        child.on('close', () => resolve(out.trim()))
        child.on('error', () => resolve(''))
      })
      check('and the machine that did it is still recorded as the committer',
        committer === 'pat', committer)

      // Without an author, a checkout with no identity still refuses.
      const anonymous2 = nodePath.join(base, 'anon2')
      await git(base, ['clone', '--quiet', remote, anonymous2])
      await git(anonymous2, ['config', '--unset', 'user.name'])
      await git(anonymous2, ['config', '--unset', 'user.email'])
      await fsp.writeFile(nodePath.join(anonymous2, 'x.txt'), 'x')
      const named = await commit(anonymous2, {
        message: 'named',
        paths: ['x.txt'],
        author: { name: 'sam', email: 'sam@example.com' }
      })
      check('an author lets a checkout with no identity commit anyway', named.ok,
        named.message + ' ' + (named.detail ?? ''))

      // A message full of quotes and newlines is text, not syntax.
      await fsp.writeFile(nodePath.join(nadia, 'game', 'scripts', 'chapter_2.rpy'), 'label two:' + L)
      const awkward = await commit(nadia, {
        message: 'He said "run!" & then;' + L + L + 'a second paragraph with $VAR and `ticks`',
        paths: ['game/scripts/chapter_2.rpy']
      })
      check('an awkward commit message is handled as text', awkward.ok,
        awkward.message + ' ' + (awkward.detail ?? ''))

      const notRepo = await readStatus(base)
      check('a folder that is not a repository says so',
        !notRepo.isRepo && (notRepo.error ?? '').includes('not a git repository'),
        String(notRepo.error))

      await fsp.rm(base, { recursive: true, force: true })
    }
  }

  console.log('\n[git sync: both sides moved on]')
  {
    // Saving in the web app commits and pushes; saving at a desk commits. Do
    // both before either reaches the other and the two histories have moved
    // apart -- which is not an exotic case, it is Tuesday.
    const os = await import('node:os')
    const fsp = (await import('node:fs')).promises
    const nodePath = await import('node:path')
    const { spawn } = await import('node:child_process')
    const L = String.fromCharCode(10)

    const git = (cwd: string, args: string[]) =>
      new Promise<{ code: number; out: string }>((resolve) => {
        const child = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
        let out = ''
        child.stdout.on('data', (d) => (out += String(d)))
        child.stderr.on('data', (d) => (out += String(d)))
        child.on('error', () => resolve({ code: -1, out }))
        child.on('close', (code) => resolve({ code: code ?? -1, out }))
      })

    const base = nodePath.join(os.tmpdir(), 'rpw-both-' + Date.now())
    const remote = nodePath.join(base, 'remote.git')
    await fsp.mkdir(base, { recursive: true })

    if ((await git(base, ['--version'])).code === 0) {
      await git(base, ['init', '--bare', '--initial-branch=main', remote])
      const clone = async (who: string): Promise<string> => {
        const dir = nodePath.join(base, who)
        await git(base, ['clone', '--quiet', remote, dir])
        await git(dir, ['config', 'user.name', who])
        await git(dir, ['config', 'user.email', who + '@example.com'])
        return dir
      }
      const at = (dir: string) => nodePath.join(dir, 'game', 'scripts', 'ch1.rpy')
      const read = (dir: string) => fsp.readFile(at(dir), 'utf8')
      const stashes = async (dir: string): Promise<number> => {
        const listed = await git(dir, ['stash', 'list'])
        return listed.out.trim() === '' ? 0 : listed.out.trim().split(L).length
      }

      const lines = [
        'label ch1:',
        '    scene bg_room',
        '    show omar concerned at left',
        '    omar "First line."',
        '    nadia "Second line."',
        '    omar "Third line."',
        ''
      ]
      const desk = await clone('desk')
      await fsp.mkdir(nodePath.join(desk, 'game', 'scripts'), { recursive: true })
      await fsp.writeFile(at(desk), lines.join(L))
      await commit(desk, { message: 'The scene', paths: ['game/scripts/ch1.rpy'], push: true })
      const phone = await clone('phone')

      // The phone saves and sends, as it does on every save.
      await fsp.writeFile(at(phone), (await read(phone)).replace('First line.', 'First line, reworded.'))
      await commit(phone, { message: 'From the phone', paths: ['game/scripts/ch1.rpy'], push: true })

      // The desk saves too, without sending: a different line of the same file.
      await fsp.writeFile(at(desk), (await read(desk)).replace('Third line.', 'Third line, reworded.'))
      await commit(desk, { message: 'From the desk', paths: ['game/scripts/ch1.rpy'] })

      const both = await readStatus(desk)
      check('both sides have moved on', both.ahead === 1 && both.behind === 0,
        both.ahead + '/' + both.behind)

      const joined = await pull(desk)
      const afterJoin = await read(desk)
      check('the two are put together without asking', joined.ok,
        joined.message + ' ' + (joined.detail ?? ''))
      check('and it says what happened in those terms',
        joined.message.includes('on top'), joined.message)
      check('the work from the phone is here', afterJoin.includes('First line, reworded.'),
        afterJoin)
      check('and the work from the desk survived', afterJoin.includes('Third line, reworded.'),
        afterJoin)
      check('no merge markers were written', !afterJoin.includes('<' + '<<<<<<'), afterJoin)
      check('nothing was left set aside', (await stashes(desk)) === 0,
        String(await stashes(desk)))

      const ready = await readStatus(desk)
      check('the desk is now only ahead, so it can send',
        ready.ahead === 1 && ready.behind === 0, ready.ahead + '/' + ready.behind)
      const sent = await push(desk)
      check('and sending works straight away', sent.ok, sent.message)

      // History stays a straight line: no merge commit for a writer to wonder at.
      const shape = await git(desk, ['log', '--oneline', '--merges'])
      check('no merge commit was invented', shape.out.trim() === '', shape.out)

      // Unsaved work on top of all that must also survive the replay.
      await git(phone, ['pull', '--quiet', '--ff-only'])
      await fsp.writeFile(at(phone), (await read(phone)).replace('Second line.', 'Second line, from the phone.'))
      await commit(phone, { message: 'Phone again', paths: ['game/scripts/ch1.rpy'], push: true })

      await fsp.writeFile(at(desk), (await read(desk)).replace('scene bg_room', 'scene bg_room_night'))
      await commit(desk, { message: 'Desk again', paths: ['game/scripts/ch1.rpy'] })
      await fsp.writeFile(at(desk), (await read(desk)).replace('at left', 'at center'))

      const withUnsaved = await pull(desk)
      const afterAll = await read(desk)
      check('a replay with unsaved work on top succeeds', withUnsaved.ok,
        withUnsaved.message + ' ' + (withUnsaved.detail ?? ''))
      check('the saved work of both sides is there',
        afterAll.includes('Second line, from the phone.') && afterAll.includes('bg_room_night'),
        afterAll)
      check('and the unsaved edit is still unsaved', afterAll.includes('at center'), afterAll)
      check('with nothing left set aside', (await stashes(desk)) === 0,
        String(await stashes(desk)))

      // ---------------------------------------------------------------
      // Both sides saved, and both changed the same line. Answering the
      // question has to finish the job: resolving and then being asked the
      // very same question again is the shape of a loop with no way out.
      await git(phone, ['pull', '--quiet', '--ff-only'])
      await fsp.writeFile(at(phone),
        (await read(phone)).replace('First line, reworded.', 'First line, theirs.'))
      await commit(phone, { message: 'Phone rewords', paths: ['game/scripts/ch1.rpy'], push: true })

      await fsp.writeFile(at(desk),
        (await read(desk)).replace('First line, reworded.', 'First line, mine.'))
      await commit(desk, { message: 'Desk rewords', paths: ['game/scripts/ch1.rpy'] })

      const facing = await readStatus(desk)
      await pull(desk)
      const standoff = await pull(desk)
      check('with both sides saved, the same line is a question',
        (standoff.conflicts ?? []).length === 1, standoff.message)
      check('and this machine really does have work of its own',
        facing.ahead > 0, String(facing.ahead))

      const decided = await resolvePull(desk, [
        { file: 'game/scripts/ch1.rpy', index: 0, take: 'mine' }
      ])
      check('answering it while ahead actually finishes', decided.ok,
        decided.message + ' ' + (decided.detail ?? ''))

      const afterDecided = await readStatus(desk)
      check('and asking again has nothing left to ask',
        afterDecided.behind === 0, String(afterDecided.behind))
      const asAgain = await pull(desk)
      check('a second attempt says it is up to date, not the same question again',
        asAgain.ok && !asAgain.conflicts, asAgain.message)

      const decidedText = await read(desk)
      check('the chosen wording is in the file', decidedText.includes('First line, mine.'),
        decidedText)
      check('and the other is not', !decidedText.includes('First line, theirs.'), decidedText)
      check('no markers reached the script', !decidedText.includes('<' + '<<<<<<'), decidedText)
      check('and nothing was left set aside', (await stashes(desk)) === 0,
        String(await stashes(desk)))
      const canSend = await push(desk)
      check('and the result can be sent', canSend.ok, canSend.message)

      await fsp.rm(base, { recursive: true, force: true })
    }
  }

  console.log('\n[git sync: bringing in changes over unsaved work]')
  {
    // The situation a writer actually hits: something arrived, and there are
    // edits here that were never saved. The old answer was a git error and a
    // trip to a terminal. These check the tool does the work instead -- and,
    // more importantly, that every way it can fail leaves the unsaved work
    // exactly where it was.
    const os = await import('node:os')
    const fsp = (await import('node:fs')).promises
    const nodePath = await import('node:path')
    const { spawn } = await import('node:child_process')
    const L = String.fromCharCode(10)

    const git = (cwd: string, args: string[]) =>
      new Promise<{ code: number; out: string }>((resolve) => {
        const child = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
        let out = ''
        child.stdout.on('data', (d) => (out += String(d)))
        child.stderr.on('data', (d) => (out += String(d)))
        child.on('error', () => resolve({ code: -1, out }))
        child.on('close', (code) => resolve({ code: code ?? -1, out }))
      })

    const base = nodePath.join(os.tmpdir(), 'rpw-aside-' + Date.now())
    const remote = nodePath.join(base, 'remote.git')
    await fsp.mkdir(base, { recursive: true })

    if ((await git(base, ['--version'])).code === 0) {
      await git(base, ['init', '--bare', '--initial-branch=main', remote])

      const clone = async (who: string): Promise<string> => {
        const dir = nodePath.join(base, who)
        await git(base, ['clone', '--quiet', remote, dir])
        await git(dir, ['config', 'user.name', who])
        await git(dir, ['config', 'user.email', who + '@example.com'])
        return dir
      }
      const scriptAt = (dir: string) => nodePath.join(dir, 'game', 'scripts', 'ch1.rpy')
      const read = (dir: string) => fsp.readFile(scriptAt(dir), 'utf8')
      const stashes = async (dir: string): Promise<number> => {
        const listed = await git(dir, ['stash', 'list'])
        return listed.out.trim() === '' ? 0 : listed.out.trim().split(L).length
      }

      // A scene with room to change different parts of it.
      const lines = [
        'label ch1:',
        '    scene bg_room',
        '    show omar concerned at left',
        '    omar "He can\'t handle anything..."',
        '    nadia "Should I go check on him?"',
        '    omar "He\'s a big boy, Sparrow."',
        ''
      ]
      const mine = await clone('mine')
      await fsp.mkdir(nodePath.join(mine, 'game', 'scripts'), { recursive: true })
      await fsp.writeFile(scriptAt(mine), lines.join(L))
      await commit(mine, { message: 'The scene', paths: ['game/scripts/ch1.rpy'], push: true })

      const theirs = await clone('theirs')

      // ---------------------------------------------------------------
      // They changed the staging; here, an unsaved edit to a different line
      // of the same file. Both should survive, with nobody asked anything.
      const staged = [...lines]
      staged[2] = '    show omar concerned at center'
      await fsp.writeFile(scriptAt(theirs), staged.join(L))
      await commit(theirs, { message: 'Move Omar to centre', paths: ['game/scripts/ch1.rpy'], push: true })

      const myEdit = [...lines]
      myEdit[4] = '    nadia "Shouldn\'t I go check on him?"'
      await fsp.writeFile(scriptAt(mine), myEdit.join(L))

      const merged = await pull(mine)
      const afterMerge = await read(mine)
      check('unsaved work no longer blocks bringing changes in', merged.ok,
        merged.message + ' ' + (merged.detail ?? ''))
      check('and says the edits were put back',
        merged.message.includes('back where they were'), merged.message)
      check('their staging change arrived',
        afterMerge.includes('at center'), afterMerge)
      check('and the unsaved line is still unsaved, not lost',
        afterMerge.includes("Shouldn't I go check"), afterMerge)
      check('nothing was left set aside', (await stashes(mine)) === 0,
        String(await stashes(mine)))
      check('and it still counts as unsaved work',
        (await readStatus(mine)).changes.length === 1,
        JSON.stringify((await readStatus(mine)).changes))

      // ---------------------------------------------------------------
      // The same line changed on both sides: a real disagreement. Nothing may
      // be half-applied, and no conflict markers may reach the .rpy file.
      const settled = await commit(mine, {
        message: 'Save the question',
        paths: ['game/scripts/ch1.rpy'],
        push: true
      })
      check('the merged scene can be saved and sent', settled.ok, settled.message)

      await git(theirs, ['pull', '--quiet', '--ff-only'])
      const theirLine = (await read(theirs)).replace(
        "He's a big boy, Sparrow.",
        "He's a grown man, Sparrow."
      )
      await fsp.writeFile(scriptAt(theirs), theirLine)
      await commit(theirs, { message: 'Reword Omar', paths: ['game/scripts/ch1.rpy'], push: true })

      const before = (await read(mine)).replace(
        "He's a big boy, Sparrow.",
        "He's old enough, Sparrow."
      )
      await fsp.writeFile(scriptAt(mine), before)
      const headBefore = (await git(mine, ['rev-parse', 'HEAD'])).out.trim()

      const clashed = await pull(mine)
      const afterClash = await read(mine)
      check('a real disagreement is reported, not merged', !clashed.ok, clashed.message)
      check('and says nothing was changed',
        clashed.message.includes('Nothing has been changed yet'), clashed.message)
      check('and names the file it happened in',
        clashed.message.includes('ch1.rpy'), clashed.message)
      check('the unsaved wording is untouched',
        afterClash.includes('old enough, Sparrow'), afterClash)
      check('their wording did not sneak in',
        !afterClash.includes('grown man'), afterClash)
      // The one that matters most: a .rpy holding these is a broken game.
      check('no conflict markers were written into the script',
        !afterClash.includes('<' + '<<<<<<') && !afterClash.includes('>' + '>>>>>>'),
        afterClash)
      check('the branch is back where it started',
        (await git(mine, ['rev-parse', 'HEAD'])).out.trim() === headBefore,
        'HEAD moved')
      check('and nothing was left set aside', (await stashes(mine)) === 0,
        String(await stashes(mine)))
      check('the working copy has no half-merged state',
        (await readStatus(mine)).conflicted.length === 0,
        JSON.stringify((await readStatus(mine)).conflicted))

      // ---------------------------------------------------------------
      // Trying again must still work: the failure left nothing behind.
      const retry = await pull(mine)
      check('the same disagreement is reported again, not something new',
        !retry.ok && retry.message.includes('Nothing has been changed yet'), retry.message)
      check('and the edits survived a second attempt',
        (await read(mine)).includes('old enough, Sparrow'), await read(mine))

      // ---------------------------------------------------------------
      // The disagreement arrives as a question, in terms the editor can show.
      check('the clash comes back as something to answer',
        (clashed.conflicts ?? []).length === 1, JSON.stringify(clashed.conflicts?.length))
      const file = clashed.conflicts![0]
      check('named against the file it is in', file.file === 'game/scripts/ch1.rpy', file.file)
      check('with one line to settle', file.regions.length === 1,
        String(file.regions.length))

      const region = file.regions[0]
      check('and both readings of it', region.mine.lines.length === 1 &&
        region.theirs.lines.length === 1,
        JSON.stringify([region.mine.lines, region.theirs.lines]))
      check('mine is the wording that was never saved',
        region.mine.lines[0].includes('old enough'), JSON.stringify(region.mine.lines))
      check('theirs is what arrived',
        region.theirs.lines[0].includes('grown man'), JSON.stringify(region.theirs.lines))
      check('and what both started from is kept too',
        region.base.lines[0].includes('big boy'), JSON.stringify(region.base.lines))

      // Parsed, so the panel can show a speaker rather than syntax.
      const spoken = region.mine.nodes[0]
      check('the line is understood as dialogue', spoken.kind === 'dialogue', spoken.kind)
      check('and knows who says it',
        spoken.kind === 'dialogue' && spoken.speaker === 'omar',
        JSON.stringify(spoken))

      // A half-answered set must not move the branch.
      const headBeforeResolve = (await git(mine, ['rev-parse', 'HEAD'])).out.trim()
      const partial = await resolvePull(mine, [])
      check('deciding nothing is refused', !partial.ok, partial.message)
      check('and the branch has not moved',
        (await git(mine, ['rev-parse', 'HEAD'])).out.trim() === headBeforeResolve, 'HEAD moved')

      // Answering it: keep my wording, take everything else.
      const resolved = await resolvePull(mine, [
        { file: 'game/scripts/ch1.rpy', index: 0, take: 'mine' }
      ])
      const afterResolve = await read(mine)
      check('answering brings the changes in', resolved.ok,
        resolved.message + ' ' + (resolved.detail ?? ''))
      check('and says what was kept', resolved.message.includes('kept 1'), resolved.message)
      check('the chosen wording is what the file says',
        afterResolve.includes('old enough, Sparrow'), afterResolve)
      check('the wording not chosen is gone',
        !afterResolve.includes('grown man'), afterResolve)
      check('no markers were written', !afterResolve.includes('<' + '<<<<<<'), afterResolve)
      check('the branch moved on to what arrived',
        (await readStatus(mine)).behind === 0, String((await readStatus(mine)).behind))
      check('and nothing was left set aside', (await stashes(mine)) === 0,
        String(await stashes(mine)))
      check('the kept line still counts as unsaved work',
        (await readStatus(mine)).changes.some((c) => c.path === 'game/scripts/ch1.rpy'),
        JSON.stringify((await readStatus(mine)).changes))

      // ---------------------------------------------------------------
      // Writing a third version, which is what two rewordings usually want.
      await commit(mine, { message: 'Settle the line', paths: ['game/scripts/ch1.rpy'], push: true })
      await git(theirs, ['pull', '--quiet', '--ff-only'])
      await fsp.writeFile(scriptAt(theirs),
        (await read(theirs)).replace('old enough, Sparrow', 'more than old enough, Sparrow'))
      await commit(theirs, { message: 'Reword again', paths: ['game/scripts/ch1.rpy'], push: true })
      await fsp.writeFile(scriptAt(mine),
        (await read(mine)).replace('old enough, Sparrow', 'quite old enough, Sparrow'))

      const second = await pull(mine)
      check('a second disagreement is offered the same way',
        (second.conflicts ?? []).length === 1, second.message)
      const own = await resolvePull(mine, [{
        file: 'game/scripts/ch1.rpy',
        index: 0,
        take: 'custom',
        text: '    omar "He is old enough, Sparrow."'
      }])
      const afterOwn = await read(mine)
      check('a line written on the spot is accepted', own.ok, own.message)
      check('and is what ends up in the script',
        afterOwn.includes('He is old enough, Sparrow.'), afterOwn)
      check('with neither of the two it replaced',
        !afterOwn.includes('quite old enough') && !afterOwn.includes('more than old enough'),
        afterOwn)
      check('and the file still parses as a script',
        parseDocument(afterOwn).nodes.some(
          (n) => n.kind === 'dialogue' && n.text.includes('He is old enough')),
        'no dialogue node')


      await fsp.rm(base, { recursive: true, force: true })
    }
  }

  console.log('\n[git sync: refused pushes]')
  {
    // A remote that will not take changes onto its main branch, which is the
    // whole point of giving a proofreader an account at all. The refusal is a
    // real pre-receive hook rather than a string this test made up, so what is
    // matched on is what git actually prints.
    const os = await import('node:os')
    const fsp = (await import('node:fs')).promises
    const nodePath = await import('node:path')
    const { spawn } = await import('node:child_process')
    const L = String.fromCharCode(10)

    const git = (cwd: string, args: string[]) =>
      new Promise<{ code: number; out: string }>((resolve) => {
        const child = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
        let out = ''
        child.stdout.on('data', (d) => (out += String(d)))
        child.stderr.on('data', (d) => (out += String(d)))
        child.on('error', () => resolve({ code: -1, out }))
        child.on('close', (code) => resolve({ code: code ?? -1, out }))
      })

    const base = nodePath.join(os.tmpdir(), 'rpw-guard-' + Date.now())
    const remote = nodePath.join(base, 'guarded.git')
    await fsp.mkdir(base, { recursive: true })

    if ((await git(base, ['--version'])).code === 0) {
      await git(base, ['init', '--bare', '--initial-branch=main', remote])

      const clone = async (who: string): Promise<string> => {
        const dir = nodePath.join(base, who)
        await git(base, ['clone', '--quiet', remote, dir])
        await git(dir, ['config', 'user.name', who])
        await git(dir, ['config', 'user.email', who + '@example.com'])
        return dir
      }
      const scene = async (dir: string, name: string): Promise<string> => {
        await fsp.mkdir(nodePath.join(dir, 'game', 'scripts'), { recursive: true })
        const rel = 'game/scripts/' + name + '.rpy'
        await fsp.writeFile(nodePath.join(dir, rel), 'label ' + name + ':' + L)
        return rel
      }
      const branches = async (): Promise<string> =>
        (await git(base, ['ls-remote', '--heads', remote])).out

      // Seed main while it is still open, then close it.
      const seeder = await clone('seeder')
      await commit(seeder, { message: 'The script', paths: [await scene(seeder, 'one')], push: true })

      // Shaped like GitLab: main is closed, and any other branch is answered
      // with a word about its merge request -- on every push, not only the one
      // that carried push options, which is how a second round of edits finds
      // the review that is already open.
      const hookPath = nodePath.join(remote, 'hooks', 'pre-receive')
      const writeHook = async (says: string): Promise<void> => {
        await fsp.writeFile(hookPath,
          '#!/bin/sh' + L +
          'branch=""' + L +
          'while read old new ref; do' + L +
          '  case "$ref" in' + L +
          '    refs/heads/main)' + L +
          '      echo "GitLab: You are not allowed to push code to protected branches." >&2' + L +
          '      exit 1;;' + L +
          '    *) branch="$ref";;' + L +
          '  esac' + L +
          'done' + L +
          'if [ -n "$branch" ]; then' + L +
          says + L +
          'fi' + L +
          'exit 0' + L, { mode: 0o755 })
      }
      await writeHook('  :')

      // The hook has to actually bite, or everything below tests nothing --
      // and it needs something to bite on, so here is a commit to send.
      await commit(seeder, { message: 'A second scene', paths: [await scene(seeder, 'two')] })
      const guarded = await git(seeder, ['push', '--quiet'])
      const hookWorks = guarded.code !== 0 && /hook declined|not allowed to push/i.test(guarded.out)
      check('the test remote really does refuse pushes to its main branch', hookWorks,
        guarded.out.slice(0, 200))

      if (hookWorks) {
        // ---------------------------------------------------------------
        // A remote too old for push options: the work still goes up, but
        // nothing was asked of anybody, and that is reported as a failure.
        const dana = await clone('dana')
        const plain = await commit(dana, {
          message: 'Fixed a typo in the first scene',
          paths: [await scene(dana, 'dana_fix')],
          push: true
        })
        check('a refused push offers the work as a branch instead',
          (await branches()).includes('refs/heads/proposal/dana-to-main'), await branches())
        check('and the commit itself is still reported as saved',
          plain.message.startsWith('Saved 1 file.'), plain.message)
        check('a branch with no merge request is a failure, not a success', !plain.ok,
          plain.message)
        check('and says plainly that nobody was asked to look',
          plain.message.includes('no merge request') &&
          plain.message.includes('proposal/dana-to-main'), plain.message)
        check('with no link offered when the remote printed none', plain.link === undefined,
          JSON.stringify(plain.link))

        // ---------------------------------------------------------------
        // A remote that takes push options and opens the merge request.
        await git(base, ['-C', remote, 'config', 'receive.advertisePushOptions', 'true'])
        await writeHook(
          '  echo "View merge request for the branch:" >&2' + L +
          '  echo "  https://gitlab.example.com/tcfm/game/-/merge_requests/7" >&2')

        const erin = await clone('erin')
        const asked = await commit(erin, {
          message: 'Reworded the confession',
          paths: [await scene(erin, 'erin_fix')],
          push: true
        })
        check('when the remote opens a merge request, that is a success', asked.ok, asked.message)
        check('and the merge request is what is reported',
          asked.message.includes('for review') &&
          asked.message.includes('proposal/erin-to-main'), asked.message)
        check('with a link straight to it',
          asked.link?.exists === true &&
          asked.link?.url === 'https://gitlab.example.com/tcfm/game/-/merge_requests/7',
          JSON.stringify(asked.link))

        // A second round of edits: the same review grows rather than a second
        // one being opened beside it.
        const more = await commit(erin, {
          message: 'And fixed the line after it',
          paths: [await scene(erin, 'erin_fix_2')],
          push: true
        })
        check('more work joins the review already open', more.ok &&
          more.message.includes('already up for review'), more.message)
        check('and goes to the same branch, not a second one',
          more.message.includes('proposal/erin-to-main') &&
          (await branches()).split('proposal/erin-to-main').length === 2,
          await branches())
        check('pointing at the same merge request',
          more.link?.url === 'https://gitlab.example.com/tcfm/game/-/merge_requests/7',
          JSON.stringify(more.link))
        check('and it really did arrive there',
          (await git(base, ['ls-remote', remote, 'refs/heads/proposal/erin-to-main'])).out
            .includes((await git(erin, ['rev-parse', 'HEAD'])).out.trim().slice(0, 12)),
          'branch tip should match erin HEAD')

        const waiting = await readStatus(erin)
        check('work sitting in a review is still ahead of the branch it targets',
          waiting.ahead === 2, String(waiting.ahead))
        check('but is known to be up for review, without asking the remote',
          waiting.awaitingReview === 'origin/proposal/erin-to-main',
          String(waiting.awaitingReview))
        // Offline is exactly when a wrong guess would hurt most. Pointing the
        // remote at nothing proves the answer came off the disk: if this ever
        // starts asking the server, this check fails.
        await git(erin, ['remote', 'set-url', 'origin', nodePath.join(base, 'nowhere.git')])
        const offline = await readStatus(erin)
        await git(erin, ['remote', 'set-url', 'origin', remote])
        check('and the answer needs no remote to give',
          offline.awaitingReview === waiting.awaitingReview, String(offline.awaitingReview))

        // Sending the same commits again must not claim a second submission.
        const again = await push(erin)
        check('sending the same work again says it is already waiting',
          again.ok && again.message.includes('already waiting'), again.message)
        check('and does not claim it was submitted a second time',
          !again.message.includes('for review'), again.message)

        // A host that says "pull request" should be quoted saying it. Being
        // told to find a merge request on a site whose every button says
        // something else sends somebody looking for the wrong thing.
        await writeHook(
          '  echo "Create a pull request for the branch by visiting:" >&2' + L +
          '  echo "  https://github.example.com/tcfm/game/pull/new/branch" >&2')

        const gh = await clone('gary')
        const ghResult = await commit(gh, {
          message: 'A line for a different host',
          paths: [await scene(gh, 'gary_fix')],
          push: true
        })
        check('a host that says pull request is quoted saying it',
          ghResult.message.includes('no pull request was created'), ghResult.message)
        check('and never the other word', !ghResult.message.includes('merge request'),
          ghResult.message)
        check('the link is labelled in its own terms',
          ghResult.link?.label === 'Open a pull request', JSON.stringify(ghResult.link))

        // ---------------------------------------------------------------
        // The trap this was built to avoid: a link to a page that WOULD open
        // a merge request is not a merge request.
        await writeHook(
          '  echo "To create a merge request for the branch, visit:" >&2' + L +
          '  echo "  https://gitlab.example.com/tcfm/game/-/merge_requests/new?x=1" >&2')

        const frank = await clone('frank')
        const offered = await commit(frank, {
          message: 'Trimmed a line',
          paths: [await scene(frank, 'frank_fix')],
          push: true
        })
        check('an offer to create a merge request is not one being created', !offered.ok,
          offered.message)
        check('the branch went up all the same',
          (await branches()).includes('refs/heads/proposal/frank-to-main'), await branches())
        check('and the link is marked as one that would open it, not one that did',
          offered.link?.exists === false &&
          offered.link?.url.includes('merge_requests/new'), JSON.stringify(offered.link))
        check('and a host that says merge request keeps that word',
          offered.link?.label === 'Open a merge request' &&
          offered.message.includes('no merge request was created'),
          JSON.stringify(offered.link) + ' | ' + offered.message)

        // ---------------------------------------------------------------
        // Being out of date is not a refusal, and must not become a proposal.
        await fsp.rename(hookPath, hookPath + '.off')
        const gwen = await clone('gwen')
        const helen = await clone('helen')
        await commit(gwen, { message: 'Later work', paths: [await scene(gwen, 'gwen_fix')], push: true })
        await fsp.rename(hookPath + '.off', hookPath)

        await commit(helen, { message: 'Older work', paths: [await scene(helen, 'helen_fix')] })
        const stale = await push(helen)
        check('being behind the remote is answered with pull, not a merge request',
          !stale.ok && stale.message.includes('Bring in changes first'), stale.message)
        check('and no branch is opened for work that is simply out of date',
          !(await branches()).includes('proposal/helen-to-main'), await branches())
      }

      await fsp.rm(base, { recursive: true, force: true })
    }
  }

  console.log('\n[render sync: planning]')
  {
    const os = await import('node:os')
    const fsp = (await import('node:fs')).promises
    const nodePath = await import('node:path')

    const root = nodePath.join(os.tmpdir(), 'rpw-renders-' + Date.now())
    const source = nodePath.join(root, 'blender', 'Chapter 1', 'Renders')
    const target = nodePath.join(root, 'game', 'images', 'ch1')
    await fsp.mkdir(source, { recursive: true })
    await fsp.mkdir(target, { recursive: true })
    await fsp.mkdir(nodePath.join(source, 'old'), { recursive: true })
    await fsp.mkdir(nodePath.join(source, 'Animations', 'walk_anim'), { recursive: true })

    const write = async (file: string, bytes = 16) =>
      fsp.writeFile(file, Buffer.alloc(bytes, 1))
    const touchTime = async (file: string, ms: number) =>
      fsp.utimes(file, new Date(ms), new Date(ms))

    // Three stills: one brand new, one whose source moved on, one settled.
    await write(nodePath.join(source, 'ch1_room_1.png'))
    await write(nodePath.join(source, 'ch1_room_2.png'))
    await write(nodePath.join(source, 'ch1_room_3.png'))
    await write(nodePath.join(target, 'ch1_room_2.webp'), 8)
    await write(nodePath.join(target, 'ch1_room_3.webp'), 8)

    // Files the scan must not treat as renders.
    await write(nodePath.join(source, 'notes.txt'))
    await write(nodePath.join(source, 'scene.blend'))
    await write(nodePath.join(source, 'old', 'ch1_room_9.png'))
    await write(nodePath.join(source, 'Animations', 'walk_anim', '0001.png'))

    const T = Date.parse('2026-01-01T12:00:00Z')
    await touchTime(nodePath.join(target, 'ch1_room_2.webp'), T)
    await touchTime(nodePath.join(source, 'ch1_room_2.png'), T + 60000)
    await touchTime(nodePath.join(target, 'ch1_room_3.webp'), T + 60000)
    await touchTime(nodePath.join(source, 'ch1_room_3.png'), T)

    const config = { sourceDir: source, targetSubdir: 'ch1' }
    const plan = await planRenderSync(root, config)

    const byName = new Map(plan.items.map((i) => [i.name, i]))
    check('only images at the top level are planned', plan.items.length === 3,
      JSON.stringify(plan.items.map((i) => i.name)))
    check('sub-folders are named rather than silently dropped',
      plan.ignoredDirs.sort().join(',') === 'Animations,old', JSON.stringify(plan.ignoredDirs))
    check('non-images are counted, not listed', plan.ignoredFiles === 2, String(plan.ignoredFiles))
    check('a still with no output is new', byName.get('ch1_room_1.png')?.status === 'new')
    check('a still whose source moved on is stale',
      byName.get('ch1_room_2.png')?.status === 'stale')
    check('a still older than its output is current',
      byName.get('ch1_room_3.png')?.status === 'current')
    check('the output name swaps the extension',
      byName.get('ch1_room_1.png')?.outputName === 'ch1_room_1.webp',
      String(byName.get('ch1_room_1.png')?.outputName))
    check('the target folder sits under game/images',
      plan.targetDir === target, plan.targetDir + ' vs ' + target)
    check('sizes and times come back for the report',
      (byName.get('ch1_room_2.png')?.targetBytes ?? 0) === 8 &&
      (byName.get('ch1_room_2.png')?.sourceModified ?? 0) === T + 60000,
      JSON.stringify(byName.get('ch1_room_2.png')))

    // Equal timestamps must not count as stale, or every scan rebuilds the lot.
    await touchTime(nodePath.join(source, 'ch1_room_1.png'), T)
    await write(nodePath.join(target, 'ch1_room_1.webp'), 8)
    await touchTime(nodePath.join(target, 'ch1_room_1.webp'), T)
    const equal = await planRenderSync(root, config)
    check('an output written at the same moment is current',
      equal.items.find((i) => i.name === 'ch1_room_1.png')?.status === 'current',
      String(equal.items.find((i) => i.name === 'ch1_room_1.png')?.status))

    // Ordering is what a person expects, not ASCII.
    await write(nodePath.join(source, 'ch1_room_10.png'))
    const ordered = await planRenderSync(root, config)
    const names = ordered.items.map((i) => i.name)
    check('stills are listed in human order',
      names.indexOf('ch1_room_2.png') > names.indexOf('ch1_room_10.png') === false &&
      names.indexOf('ch1_room_10.png') > names.indexOf('ch1_room_1.png'),
      JSON.stringify(names))

    // Sub-folders, off by default and on when asked for.
    await write(nodePath.join(source, 'old', 'ch1_room_9.png'))
    await fsp.mkdir(nodePath.join(source, 'scene_a'), { recursive: true })
    await fsp.mkdir(nodePath.join(source, 'scene_b'), { recursive: true })
    await fsp.mkdir(nodePath.join(source, '.cache'), { recursive: true })
    await write(nodePath.join(source, 'scene_a', 'shot_01.png'))
    await write(nodePath.join(source, 'scene_b', 'shot_01.png'))
    await write(nodePath.join(source, '.cache', 'junk.png'))

    const flat = await planRenderSync(root, config)
    check('sub-folders stay out unless asked for',
      !flat.items.some((i) => i.name.includes('/')),
      JSON.stringify(flat.items.map((i) => i.name)))

    const deep = await planRenderSync(root, { ...config, includeSubfolders: true })
    const deepNames = deep.items.map((i) => i.name)
    check('turning it on brings the sub-folders in',
      deepNames.includes('scene_a/shot_01.png') &&
      deepNames.includes('scene_b/shot_01.png') &&
      deepNames.includes('old/ch1_room_9.png'),
      JSON.stringify(deepNames))
    check('the top level is still there too',
      deepNames.includes('ch1_room_1.png'), JSON.stringify(deepNames))
    check('nothing is reported as ignored any more', deep.ignoredDirs.length === 0,
      JSON.stringify(deep.ignoredDirs))
    check('dot-folders are skipped even so',
      !deepNames.some((n) => n.startsWith('.cache')), JSON.stringify(deepNames))

    const shots = deep.items.filter((i) => i.name.endsWith('shot_01.png'))
    check('two shots of the same name do not collide',
      shots.length === 2 && new Set(shots.map((i) => i.outputName)).size === 2,
      JSON.stringify(shots.map((i) => i.outputName)))
    check('the sub-folder is kept in the output path',
      shots.every((i) => i.outputName === i.name.replace('.png', '.webp')),
      JSON.stringify(shots.map((i) => i.name + ' -> ' + i.outputName)))

    // Staleness has to work through a sub-folder as well.
    await fsp.mkdir(nodePath.join(target, 'scene_a'), { recursive: true })
    await write(nodePath.join(target, 'scene_a', 'shot_01.webp'), 8)
    await touchTime(nodePath.join(target, 'scene_a', 'shot_01.webp'), T)
    await touchTime(nodePath.join(source, 'scene_a', 'shot_01.png'), T)
    const nested = await planRenderSync(root, { ...config, includeSubfolders: true })
    check('a nested output is matched to its nested source',
      nested.items.find((i) => i.name === 'scene_a/shot_01.png')?.status === 'current' &&
      nested.items.find((i) => i.name === 'scene_b/shot_01.png')?.status === 'new',
      JSON.stringify(nested.items.filter((i) => i.name.includes('/')).map((i) => i.name + ':' + i.status)))

    const missing = await planRenderSync(root, { sourceDir: source + '-gone', targetSubdir: 'ch1' })
    check('a missing render folder is reported, not thrown',
      (missing.error ?? '').includes('does not exist'), String(missing.error))
    check('a missing folder plans nothing', missing.items.length === 0)

    const unset = await planRenderSync(root, { sourceDir: '', targetSubdir: '' })
    check('an unconfigured episode says so', (unset.error ?? '').includes('No render folder'),
      String(unset.error))

    check('an empty sub-folder writes straight to images',
      targetDirFor(root, { sourceDir: source, targetSubdir: '' }) ===
        nodePath.join(root, 'game', 'images'),
      targetDirFor(root, { sourceDir: source, targetSubdir: '' }))
    check('a sub-folder with slashes is still contained',
      targetDirFor(root, { sourceDir: source, targetSubdir: '/ch1/' }) === target,
      targetDirFor(root, { sourceDir: source, targetSubdir: '/ch1/' }))

    check('quality defaults to the top of the lossy scale', clampQuality(undefined) === 100)
    check('quality is clamped into range',
      clampQuality(0) === 1 && clampQuality(500) === 100 && clampQuality(85) === 85)

    // A missing encoder is reported per item rather than crashing the run.
    const failed = await convertRender(
      { encoder: 'ffmpeg', ffmpegPath: 'definitely-not-ffmpeg-xyz', quality: 100 },
      nodePath.join(source, 'ch1_room_1.png'),
      nodePath.join(target, 'ch1_room_1.webp')
    )
    check('a missing ffmpeg is reported as such',
      !failed.ok && (failed.error ?? '').includes('ffmpeg was not found'), String(failed.error))

    const unsafe = await convertRender(
      { encoder: 'ffmpeg', ffmpegPath: 'ffmpeg && del *', quality: 100 },
      nodePath.join(source, 'ch1_room_1.png'),
      nodePath.join(target, 'x.webp')
    )
    check('an encoder path with shell syntax is refused',
      !unsafe.ok && (unsafe.error ?? '').includes('not a valid command'), String(unsafe.error))

    check('exactly 1 would switch Chromium to lossless, so it is held below',
      canvasQuality(100) === 0.995 && canvasQuality(95) === 0.95,
      canvasQuality(100) + ' / ' + canvasQuality(95))
    check('a low quality maps straight through', canvasQuality(60) === 0.6,
      String(canvasQuality(60)))

    // TIFF was dropped from the accepted list: Chromium cannot decode it, and
    // a format that fails on every file is worse than one that is not offered.
    await write(nodePath.join(source, 'ch1_room_5.tiff'))
    const noTiff = await planRenderSync(root, config)
    check('a format Chromium cannot decode is not planned',
      !noTiff.items.some((i) => i.name.endsWith('.tiff')),
      JSON.stringify(noTiff.items.map((i) => i.name)))

    await fsp.rm(root, { recursive: true, force: true })
  }

  console.log('\n[render sync: finding an encoder]')
  {
    check('a command that is not there does not answer',
      (await probeFfmpeg('definitely-not-ffmpeg-xyz')) === null)
    check('a command with shell syntax is never run',
      (await probeFfmpeg('ffmpeg && del *')) === null)

    // Whatever this machine has, the shape of the answer must be usable.
    const status = await findFfmpeg('definitely-not-ffmpeg-xyz')
    check('a configured command that fails is reported against that command',
      status.ok === false && (status.error ?? '').includes('definitely-not-ffmpeg-xyz'),
      String(status.error))
    check('candidates carry a command, a version and a label',
      status.candidates.every((c) => c.command && c.version && c.label),
      JSON.stringify(status.candidates))
    check('the failing command is not offered back as a candidate',
      !status.candidates.some((c) => c.command === 'definitely-not-ffmpeg-xyz'),
      JSON.stringify(status.candidates.map((c) => c.command)))

    const plain = await findFfmpeg('')
    check('an unset command falls back to the plain name',
      plain.ok ? plain.command === 'ffmpeg' : (plain.error ?? '').includes('ffmpeg was not found'),
      JSON.stringify({ ok: plain.ok, command: plain.command, error: plain.error }))
    if (plain.ok) {
      check('a working encoder reports its version', (plain.version ?? '').length > 0,
        String(plain.version))
      check('a working encoder offers no alternatives', plain.candidates.length === 0)
    }
  }

  console.log('\n[proofreading: choosing what to send]')
  {
    check('an English line is worth proofreading', needsProofreading('Answer me, and no bullshit.'))
    check('a Czech line is left for the translator', !needsProofreading('Kde se fláká?'))
    check('an unrecognised line is still sent', needsProofreading('Hmm... [player_name]?'))
    check('proofreading and translating want opposite lines',
      needsProofreading('Kde se fláká?') === !needsTranslation('Kde se fláká?'))

    const prompt = buildProofreadPrompt(
      [
        { id: 1, text: 'i aint got nothin.', speaker: 'Omar', accent: 'Ghetto' },
        { id: 2, text: 'Leave', speaker: null, isChoice: true }
      ],
      'English'
    )
    check('the proofread prompt names the language', prompt.includes('written in English'))
    check('it forbids rewriting meaning', prompt.includes('Do not change what a line means'))
    check('it protects dialect from correction',
      prompt.includes('Do not neutralise a voice'), prompt.slice(0, 400))
    check('it passes the accent through', prompt.includes('Omar: Ghetto'))
    check('it says accents must survive', prompt.includes('must survive the pass'))
    check('it leaves other languages alone',
      prompt.includes('If a line is not in English, return it unchanged.'))
    check('it asks for revisions', prompt.includes('{"revisions":[{"id":1,"text":"..."}]}'))
    check('a choice is marked as one', prompt.includes('"speaker":"CHOICE"'))
    check('it never asks for a translation', !prompt.toLowerCase().includes('translat'))

    const revisions = parseResponse('{"revisions":[{"id":2,"text":"Leave."}]}')
    check('a revisions reply parses', revisions.byId.get(2) === 'Leave.',
      JSON.stringify([...revisions.byId]))
    check('a translations reply still parses',
      parseResponse('{"translations":[{"id":1,"text":"x"}]}').byId.get(1) === 'x')
  }

  console.log('\n[proofreading: applying results to a script]')
  {
    const L = String.fromCharCode(10)
    const script = [
      'label D17_TEST:',
      '    # Omar is on the bed',
      '    scene bg_kitchen',
      '    omar "Kde se fláká?"',
      '    nadia "Answer me. And no bullshit."',
      '    omar serious "{i}Nejsem na to hrdej{/i}, ale uz me to sralo."',
      '    "Narrator line, ktera je ceska."',
      '    menu:',
      '        "Odejit":',
      '            jump SOMEWHERE',
      '    return',
      ''
    ].join(L)

    const cast = [
      { varName: 'omar', name: 'Omar', expressions: [], portraits: {} },
      { varName: 'nadia', name: 'Nadia', expressions: [], portraits: {} }
    ]
    const profiles = [{ id: 'p1', varNames: ['nadia'], name: 'Nadia', accent: 'Southerner' }]

    let sent = ''
    const fake = async (prompt) => {
      sent = prompt
      const ids = [...prompt.matchAll(/"id":(\d+)/g)].map((m) => Number(m[1]))
      const texts = [...prompt.matchAll(/"text":("(?:[^"\\]|\\.)*")/g)].map((m) => JSON.parse(m[1]))
      return {
        ok: true,
        output: JSON.stringify({
          revisions: ids.map((id, i) => ({ id, text: 'OK<' + texts[i] + '>' }))
        })
      }
    }

    const result = await runPass(script,
      { mode: 'proofread' as const, sourceLanguage: 'cs', targetLanguage: 'en', cast, profiles }, fake)

    check('untranslated Czech lines are skipped', result.skipped === 3, String(result.skipped))
    check('the Czech dialogue is untouched',
      result.content.includes('omar "Kde se fláká?"') &&
      result.content.includes('"Narrator line, ktera je ceska."'), result.content)
    check('a Czech line with markup is untouched',
      result.content.includes('{i}Nejsem na to hrdej{/i}, ale uz me to sralo.'), result.content)
    check('the English line was corrected',
      result.content.includes('nadia "OK<Answer me. And no bullshit.>"'), result.content)
    check('a menu choice is proofread too',
      result.content.includes('"OK<Odejit>":'), result.content)
    check('the accent of the corrected speaker reached the prompt',
      sent.includes('Nadia: Southerner'), sent.slice(0, 300))
    check('code and comments are untouched',
      result.content.includes('# Omar is on the bed') &&
      result.content.includes('scene bg_kitchen') &&
      result.content.includes('jump SOMEWHERE'))
    check('changes carry before and after', result.changes.length === 2 &&
      result.changes.every((c) => c.before && c.after && c.line > 0),
      JSON.stringify(result.changes.map((c) => c.line)))
    check('the corrected line number is right',
      result.changes[0].line === 5, JSON.stringify(result.changes[0]))

    // The two passes are mirror images over the same file.
    const translated = await runPass(script,
      { mode: 'translate' as const, sourceLanguage: 'cs', targetLanguage: 'en', cast, profiles },
      async (prompt) => {
        const ids = [...prompt.matchAll(/"id":(\d+)/g)].map((m) => Number(m[1]))
        return { ok: true, output: JSON.stringify({ translations: ids.map((id) => ({ id, text: 'T' })) }) }
      })
    check('what one pass skips, the other works on',
      translated.skipped + result.skipped === 4 &&
      translated.changes.length + result.changes.length === 6,
      translated.skipped + '/' + result.skipped + ' ' +
      translated.changes.length + '/' + result.changes.length)

    // A selection limits the pass.
    const partial = await runPass(script,
      { mode: 'proofread' as const, sourceLanguage: 'cs', targetLanguage: 'en', cast, profiles, lines: [5] }, fake)
    check('a line restriction limits the proofread', partial.changes.length === 1 &&
      partial.changes[0].line === 5, JSON.stringify(partial.changes.map((c) => c.line)))
    check('the choice outside the selection is untouched',
      partial.content.includes('"Odejit":'), partial.content)

    // A line the proofreader hands back unchanged is not a change.
    const unchanged = await runPass(script,
      { mode: 'proofread' as const, sourceLanguage: 'cs', targetLanguage: 'en', cast, profiles },
      async (prompt) => {
        const ids = [...prompt.matchAll(/"id":(\d+)/g)].map((m) => Number(m[1]))
        const texts = [...prompt.matchAll(/"text":("(?:[^"\\]|\\.)*")/g)].map((m) => JSON.parse(m[1]))
        return { ok: true, output: JSON.stringify({ revisions: ids.map((id, i) => ({ id, text: texts[i] })) }) }
      })
    check('a clean script reports no changes', unchanged.changes.length === 0 &&
      unchanged.content === script, String(unchanged.changes.length))

    const failed = await runPass(script,
      { mode: 'proofread' as const, sourceLanguage: 'cs', targetLanguage: 'en', cast, profiles },
      async () => ({ ok: false, output: '', error: 'CLI not found' }))
    check('a failed proofread reports the error', failed.error === 'CLI not found')
    check('a failed proofread leaves the script alone', failed.content === script)
  }

  console.log('\n[translation: the CLI runner]')
  {
    const bad = await cliRunner('claude && rm -rf /')('hi')
    check('a command with shell metacharacters is refused', !bad.ok &&
      bad.error!.includes('not a valid command'), String(bad.error))
    const path1 = await cliRunner('C:/tools/claude.cmd')
    check('a plain path is accepted as a command', typeof path1 === 'function')
    // A Windows path is the normal way to name the command on the platform the
    // app is used on, so backslashes have to survive the guard.
    const B = String.fromCharCode(92)
    const windowsPath = await cliRunner('C:' + B + 'tools' + B + 'claude.cmd')('hi')
    check('a Windows path is not mistaken for shell syntax',
      !(windowsPath.error ?? '').includes('not a valid command'), String(windowsPath.error))
    const sneaky = await cliRunner('claude' + B + ' && del x')('hi')
    check('a backslash does not smuggle a second command past the guard',
      (sneaky.error ?? '').includes('not a valid command'), String(sneaky.error))

    const missing = await cliRunner('definitely-not-a-real-command-xyz')('hi')
    check('a missing command is reported as not installed', !missing.ok &&
      missing.error!.includes('Install it'), String(missing.error))
  }

  console.log(`\n${pass} passed, ${fail} failed`)
  if (fail > 0) process.exitCode = 1
}

main().catch((e) => {
  console.error(e)
  process.exitCode = 1
})
