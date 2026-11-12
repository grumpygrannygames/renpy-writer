/**
 * The little of Node's `process` that the shared code reads: a number to keep
 * temporary file names apart, and the platform, which is neither Windows nor
 * anything with a home folder of renders.
 */
const g = globalThis as { process?: unknown }
if (!g.process) {
  g.process = {
    pid: Math.floor(Math.random() * 1e6),
    platform: 'android',
    env: {},
    cwd: () => '/'
  }
}

export {}
