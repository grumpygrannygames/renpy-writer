import * as path from 'node:path'
import { startServer } from './index'

/**
 * Run the server from a terminal.
 *
 *   npm run serve -- --project /srv/tcfm --data ./.server-data --port 4321
 *
 * Projects are named here rather than added from the app: on a server the list
 * of folders the app may touch belongs to whoever runs it.
 *
 * It binds to loopback unless asked otherwise, and refuses to listen beyond it
 * until an account exists. Make one with: npm run account -- add <name>
 */
const arg = (name: string, fallback?: string): string | undefined => {
  const at = process.argv.indexOf('--' + name)
  return at === -1 ? fallback : process.argv[at + 1]
}

const host = arg('host', '127.0.0.1')!
const running = await startServer({
  dataDir: path.resolve(arg('data', '.server-data')!),
  webRoot: path.resolve(arg('web', 'out/renderer')!),
  port: Number(arg('port', '4321')),
  host,
  // Repeatable: --project one --project two
  projects: process.argv
    .map((a, i) => (a === '--project' ? process.argv[i + 1] : null))
    .filter((p): p is string => Boolean(p)),
  allowNetwork: process.argv.includes('--allow-network'),
  secureCookies: process.argv.includes('--insecure-cookies')
    ? false
    : process.argv.includes('--secure-cookies') || undefined
})

console.log(`Ren'Py Writer is at http://${host}:${running.port}`)
// Report what was actually resolved, not what the host name suggests: saying
// cookies are Secure when they are not sends somebody chasing the wrong thing.
if (host === '127.0.0.1') {
  console.log('Loopback only. Pass --host 0.0.0.0 --allow-network to reach it from elsewhere.')
} else if (running.secureCookies) {
  console.log('Session cookies are marked Secure, so signing in needs HTTPS in front of this.')
  console.log('On a private network you trust, --insecure-cookies allows plain HTTP.')
} else {
  console.log('Session cookies are NOT marked Secure: fine on a private network, not on the')
  console.log('open internet, where anyone on the path could copy one.')
}
