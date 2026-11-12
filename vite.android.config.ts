import { resolve } from 'path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

/**
 * The Android build: the interface plus the shared core, in one page.
 *
 * On a desktop and a server the core runs in Node. On a phone it runs in the
 * WebView beside the interface, so the few Node modules it uses are swapped
 * for ones the Android app answers (src/android/shims), and nothing else in
 * the core changes.
 */
const shims = resolve('src/android/shims')

export default defineConfig({
  root: 'src/android',
  base: './',
  build: {
    outDir: resolve('out/android'),
    emptyOutDir: true,
    target: 'es2022'
  },
  resolve: {
    alias: [
      { find: '@shared', replacement: resolve('src/shared') },
      { find: '@core', replacement: resolve('src/core') },
      { find: '@', replacement: resolve('src/renderer/src') },
      { find: /^(node:)?fs$/, replacement: `${shims}/fs.ts` },
      { find: /^(node:)?child_process$/, replacement: `${shims}/child_process.ts` },
      { find: /^(node:)?os$/, replacement: `${shims}/os.ts` },
      { find: /^(node:)?crypto$/, replacement: `${shims}/crypto.ts` },
      { find: /^(node:)?path$/, replacement: resolve('node_modules/path-browserify/index.js') }
    ]
  },
  plugins: [react()]
})
