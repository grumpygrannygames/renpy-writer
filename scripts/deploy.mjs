#!/usr/bin/env node
/**
 * Put the current build on the server.
 *
 * One command rather than four, because the four have to all succeed: a
 * server bundle newer than the renderer that reaches it produces behaviour
 * that makes sense from neither side. This builds everything, sends it in one
 * archive, restarts, and then asks the public address whether it is answering
 * -- and stops at the first thing that fails rather than carrying on.
 *
 * Where to deploy is read from .deploy.json, which is not committed: it names
 * somebody's server, and this repository is meant to be shareable.
 */
import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const configPath = path.join(root, '.deploy.json')

const EXAMPLE = `{
  "host": "203.0.113.10",
  "user": "root",
  "key": "~/.ssh/renpywriter_droplet",
  "appDir": "/srv/renpywriter/app",
  "owner": "renpy:renpy",
  "service": "renpywriter",
  "url": "https://tcfm.example.com/"
}`

/**
 * The build tools are run through node directly rather than through npx.
 *
 * On Windows npx is a .cmd wrapper, and node refuses to spawn those without a
 * shell -- and going through a shell means every path with a space in it
 * becomes a quoting problem. Their entry points are ordinary JavaScript, so
 * this runs them the same way on every platform.
 */
const TOOLS = {
  tsc: 'node_modules/typescript/bin/tsc',
  'electron-vite': 'node_modules/electron-vite/bin/electron-vite.js',
  esbuild: 'node_modules/esbuild/bin/esbuild'
}

/** Run a command, letting its output through, and reject on any failure. */
function run(command, args, options = {}) {
  const tool = TOOLS[command]
  const [runner, runnerArgs] = tool
    ? [process.execPath, [path.join(root, tool), ...args]]
    : [command, args]
  return new Promise((resolve, reject) => {
    const child = spawn(runner, runnerArgs, { cwd: root, stdio: 'inherit', ...options })
    child.on('error', (e) => reject(new Error(`${command} could not start: ${e.message}`)))
    child.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`${command} ${args[0] ?? ''} failed (${code})`))
    )
  })
}

/** Run a command and keep its output, for the checks at the end. */
function capture(command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    child.stdout.on('data', (d) => (out += String(d)))
    child.stderr.on('data', (d) => (out += String(d)))
    child.on('error', () => resolve({ code: -1, out }))
    child.on('close', (code) => resolve({ code: code ?? -1, out }))
  })
}

const step = (what) => console.log(`\n== ${what}`)

async function main() {
  let config
  try {
    config = JSON.parse(await fs.readFile(configPath, 'utf8'))
  } catch (e) {
    const why = e.code === 'ENOENT' ? 'There is no .deploy.json.' : `.deploy.json: ${e.message}`
    throw new Error(`${why}\n\nCreate one next to package.json:\n\n${EXAMPLE}\n`)
  }

  for (const field of ['host', 'user', 'key', 'appDir', 'service', 'url']) {
    if (!config[field]) throw new Error(`.deploy.json is missing "${field}".`)
  }
  const key = config.key.startsWith('~') ? path.join(os.homedir(), config.key.slice(1)) : config.key
  const target = `${config.user}@${config.host}`
  const ssh = ['-i', key, '-o', 'ConnectTimeout=15', '-o', 'BatchMode=yes']

  step('checking types')
  await run('tsc', ['--noEmit', '-p', 'tsconfig.node.json'])
  await run('tsc', ['--noEmit', '-p', 'tsconfig.web.json'])

  step('building')
  await run('electron-vite', ['build'])
  for (const [entry, out] of [
    ['src/server/main.ts', 'out/server/main.mjs'],
    ['src/server/accounts.ts', 'out/server/accounts.mjs']
  ]) {
    await run('esbuild', [
      entry,
      '--bundle', '--platform=node', '--format=esm', '--packages=external',
      '--alias:@shared=./src/shared', '--alias:@core=./src/core',
      `--outfile=${out}`, '--log-level=error'
    ])
  }

  step('packing')
  // Kept beside package.json and named relatively: GNU tar reads a leading
  // "C:" as a host to connect to, so an absolute Windows path never gets as
  // far as being a filename.
  const archiveName = `deploy-${Date.now()}.tgz`
  const archive = path.join(root, archiveName)
  await run('tar', ['-czf', archiveName, '-C', 'out',
    'server/main.mjs', 'server/accounts.mjs', 'renderer'])
  const { size } = await fs.stat(archive)
  console.log(`   ${(size / 1024).toFixed(0)} kB`)

  step(`sending to ${target}`)
  const remoteArchive = `/tmp/${archiveName}`
  await run('scp', [...ssh, '-q', archive, `${target}:${remoteArchive}`])

  step('installing and restarting')
  // Unpacked into place, then restarted, then the archive is removed --
  // in that order, so a failure leaves something to look at.
  const owner = config.owner ?? 'renpy:renpy'
  await run('ssh', [...ssh, target,
    `set -e; tar -xzf ${remoteArchive} -C ${config.appDir}; ` +
    `chown -R ${owner} ${config.appDir}; ` +
    `systemctl restart ${config.service}; sleep 3; ` +
    `systemctl is-active ${config.service}; rm -f ${remoteArchive}`])
  await fs.rm(archive, { force: true })

  step('checking it answers')
  const answered = await capture('curl', ['-s', '-o', os.devNull, '-w', '%{http_code}', '-m', '20', config.url])
  const code = answered.out.trim()
  if (code !== '200') {
    throw new Error(`${config.url} answered ${code || 'nothing'}. The service may be up but broken; ` +
      `check: ssh -i ${config.key} ${target} journalctl -u ${config.service} -n 50`)
  }
  console.log(`   ${config.url} -> 200`)

  console.log('\nDeployed. Reload the page to pick it up.\n')
}

main().catch((e) => {
  console.error(`\nDeploy stopped: ${e.message}\n`)
  process.exit(1)
})
