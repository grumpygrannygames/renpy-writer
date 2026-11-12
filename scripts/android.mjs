#!/usr/bin/env node
/**
 * Build the Android app: `npm run android`.
 *
 * 1. git for Android goes into the app, if it is not there yet
 *    (scripts/android-git.py, which needs Python 3).
 * 2. The interface and the shared core are bundled for the WebView.
 * 3. Capacitor copies that bundle into the Android project.
 * 4. Gradle builds the .apk.
 *
 * Needs a JDK (21) and the Android SDK. Both are found where their installers
 * put them on Windows, or from JAVA_HOME and ANDROID_HOME anywhere.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const android = join(root, 'android')
const windows = process.platform === 'win32'

function say(what) {
  console.log(`== ${what}`)
}

function run(command, args, options = {}) {
  execFileSync(command, args, { stdio: 'inherit', cwd: root, shell: windows, ...options })
}

function findJdk() {
  if (process.env.JAVA_HOME && existsSync(process.env.JAVA_HOME)) return process.env.JAVA_HOME
  const base = 'C:\\Program Files\\Eclipse Adoptium'
  if (windows && existsSync(base)) {
    const jdk = readdirSync(base).filter((d) => d.startsWith('jdk-21')).sort().pop()
    if (jdk) return join(base, jdk)
  }
  throw new Error('No JDK found. Install Java 21 (Eclipse Temurin) or set JAVA_HOME.')
}

function findSdk() {
  for (const candidate of [
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    windows ? join(process.env.LOCALAPPDATA ?? '', 'Android', 'Sdk') : join(homedir(), 'Android', 'Sdk')
  ]) {
    if (candidate && existsSync(join(candidate, 'platforms'))) return candidate
  }
  throw new Error('No Android SDK found. Install it, or set ANDROID_HOME.')
}

const jdk = findJdk()
const sdk = findSdk()
const env = { ...process.env, JAVA_HOME: jdk, ANDROID_HOME: sdk }

if (!existsSync(join(android, 'app', 'src', 'main', 'jniLibs', 'arm64-v8a', 'libgit.so'))) {
  say('git for Android')
  run(windows ? 'python' : 'python3', ['scripts/android-git.py'])
}

say('bundling the app')
run('npx', ['vite', 'build', '-c', 'vite.android.config.ts', '--logLevel', 'warn'])

say('copying it into the Android project')
run('npx', ['cap', 'sync', 'android'], { env })

// Gradle reads the SDK's whereabouts from here; it is this machine's, not the repo's.
writeFileSync(join(android, 'local.properties'), `sdk.dir=${sdk.replace(/\\/g, '/')}\n`)

say('building the .apk')
// Quoted for the shell Windows needs to run a .bat, since the folder may have a space in it.
const gradlew = join(android, windows ? 'gradlew.bat' : 'gradlew')
run(windows ? `"${gradlew}"` : gradlew, ['assembleDebug', '--quiet'], { cwd: android, env })

const apk = join(android, 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk')
console.log(`\nBuilt ${apk}`)
