/**
 * Bundle tests/android/check.ts the way the Android app is bundled -- Node's
 * modules swapped for the phone's shims -- except that the Java plugin is
 * played by tests/android/fakeHost.ts. Then run it.
 */
import { build } from 'esbuild'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..', '..')
const shims = resolve(root, 'src/android/shims')
const out = resolve(root, 'node_modules/.cache/android-check.mjs')

await build({
  entryPoints: [resolve(root, 'tests/android/check.ts')],
  bundle: true,
  platform: 'neutral',
  format: 'esm',
  outfile: out,
  logLevel: 'error',
  mainFields: ['module', 'main'],
  alias: {
    '@shared': resolve(root, 'src/shared'),
    '@core': resolve(root, 'src/core'),
    fs: `${shims}/fs.ts`,
    'node:fs': `${shims}/fs.ts`,
    child_process: `${shims}/child_process.ts`,
    'node:child_process': `${shims}/child_process.ts`,
    os: `${shims}/os.ts`,
    'node:os': `${shims}/os.ts`,
    crypto: `${shims}/crypto.ts`,
    'node:crypto': `${shims}/crypto.ts`,
    path: resolve(root, 'node_modules/path-browserify/index.js'),
    'node:path': resolve(root, 'node_modules/path-browserify/index.js')
  },
  plugins: [
    {
      name: 'fake-native',
      setup(b) {
        // The phone code reaches the Java side through ../native or ./native.
        b.onResolve({ filter: /^\.\.?\/native$/ }, (args) =>
          args.importer.includes(`${'src'}`) && args.importer.includes('android')
            ? { path: resolve(root, 'tests/android/fakeHost.ts') }
            : undefined
        )
        // Capacitor itself is not needed when the plugin is played by Node.
        b.onResolve({ filter: /^@capacitor\/core$/ }, () => ({
          path: 'capacitor',
          namespace: 'stub'
        }))
        b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
          contents: 'export const registerPlugin = () => ({})',
          loader: 'js'
        }))
      }
    }
  ]
})

execFileSync(process.execPath, [out], { stdio: 'inherit' })
