/**
 * Headless server: the deemix backend in plain Node (no Electron, no window),
 * with the web UI served on http://<host>:<port> behind a password.
 *
 * Environment:
 *   DEEMIX_PASSWORD           required (unless DEEMIX_INSECURE_NO_AUTH=1)
 *   DEEMIX_DATA_DIR           settings, credentials, caches  (default ./data)
 *   DEEMIX_MUSIC_DIR          download folder(s), ':'-separated (default ./music)
 *   DEEMIX_HOST / DEEMIX_PORT bind address (default 0.0.0.0:6595)
 *   DEEMIX_WEB_DIR            built renderer (default ../dist next to this file)
 *   DEEMIX_TRUST_PROXY=1      honour X-Forwarded-* from a reverse proxy
 *   DEEMIX_INSECURE_NO_AUTH=1 disable the password (trusted networks only)
 */
import * as path from 'path'
import { existsSync, mkdirSync } from 'fs'

// Backend modules resolve their storage folder lazily via runtimePaths.userDataDir(),
// which reads this variable; set it before anything starts.
const DATA_DIR = path.resolve(process.env.DEEMIX_DATA_DIR || './data')
process.env.DEEMIX_DATA_DIR = DATA_DIR
// Where this bundle really lives (Bun bakes __dirname in at build time).
const BUNDLE_DIR = path.dirname(path.resolve(require.main?.filename || process.argv[1] || __filename))
process.env.DEEMIX_BUNDLE_DIR = BUNDLE_DIR

import { DeemixServer, setAllowedDownloadRoots } from '../server'
import { bootstrapServer } from '../serverBootstrap'
import { playlistSync } from '../services/playlistSync'
import { artistSync } from '../services/artistSync'
import { deezerAuth } from '../services/deezerAuth'
import { RemoteAuth } from './auth'
import { EventHub } from './events'
import { StaticSite } from './static'
import { HeadlessStorage, decodeCredential } from './storage'
import { HeadlessFrontDoor } from './frontDoor'

declare const __APP_VERSION__: string
const VERSION = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'dev'

function fatal(message: string): never {
  console.error(`[Headless] ${message}`)
  process.exit(1)
}

async function main(): Promise<void> {
  const host = process.env.DEEMIX_HOST || '0.0.0.0'
  const port = Number(process.env.DEEMIX_PORT || 6595)
  if (!Number.isInteger(port) || port < 1 || port > 65535) fatal(`Invalid DEEMIX_PORT: ${process.env.DEEMIX_PORT}`)

  const musicRoots = (process.env.DEEMIX_MUSIC_DIR || './music')
    .split(':').map(p => p.trim()).filter(Boolean).map(p => path.resolve(p))
  const webDir = path.resolve(process.env.DEEMIX_WEB_DIR || path.join(BUNDLE_DIR, '..', 'dist'))
  const trustProxy = process.env.DEEMIX_TRUST_PROXY === '1'

  const password = process.env.DEEMIX_PASSWORD || ''
  const insecure = process.env.DEEMIX_INSECURE_NO_AUTH === '1'
  if (!password && !insecure) {
    fatal('DEEMIX_PASSWORD is not set. Set a password, or DEEMIX_INSECURE_NO_AUTH=1 to run without one (anyone who can reach the port can use your Deezer account).')
  }
  if (password && password.length < 8) fatal('DEEMIX_PASSWORD must be at least 8 characters.')

  mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 })
  for (const root of musicRoots) mkdirSync(root, { recursive: true })

  const storage = new HeadlessStorage(DATA_DIR)
  await storage.init()
  const auth = password ? new RemoteAuth(password, RemoteAuth.loadSecret(DATA_DIR)) : null
  const events = new EventHub()
  const site = new StaticSite(webDir)

  // Downloads may only land inside the mounted music folder(s).
  setAllowedDownloadRoots(musicRoots)

  const server = new DeemixServer(host, port)

  // First run: point downloads at the music volume instead of ~/Music/Deemix.
  const persisted: any = await storage.loadSettings()
  if (!persisted?.downloadPath) server.updateSettings({ downloadPath: musicRoots[0] })

  server.setRemoteAccess(new HeadlessFrontDoor({
    auth,
    storage,
    events,
    site,
    musicRoots,
    downloadRoot: () => server.getSettings().downloadPath,
    version: VERSION,
    trustProxy
  }))

  await server.start()
  if (server.getPort() !== port) {
    server.stop()
    fatal(`Port ${port} is already in use.`)
  }

  server.on('auth-expired', (data: unknown) => events.send('auth:expired', data))
  server.on('qobuz-auth-expired', (data: unknown) => events.send('qobuz-auth:expired', data))
  server.on('session-health', (data: unknown) => events.send('session:health', data))

  // No window opens at boot to re-login (the desktop UI does that), so restore
  // the Deezer session here: scheduled syncs must work with no browser open.
  const saved = await storage.loadCredentials()
  if (saved.arl) {
    const timeout = new Promise<'timeout'>(r => setTimeout(() => r('timeout'), 20_000).unref())
    const outcome = await Promise.race([
      deezerAuth.login(saved.arl).then(() => 'ok' as const, (e: any) => `failed: ${e?.message ?? e}`),
      timeout
    ])
    console.log(`[Headless] Deezer session restore: ${outcome}`)
  }

  await bootstrapServer(server, {
    credentialsPath: storage.credentialsPath,
    settingsPath: storage.settingsPath,
    decodeCredential,
    forward: (channel, data) => events.send(channel, data)
  })

  console.log(`[Headless] deemix ${VERSION} listening on http://${host}:${port}`)
  console.log(`[Headless] data: ${DATA_DIR}  music: ${musicRoots.join(', ')}  web: ${webDir}`)
  const workerFile = path.join(BUNDLE_DIR, 'decryptWorker.js')
  if (existsSync(workerFile)) console.log(`[Headless] decrypt worker: ok (${workerFile})`)
  else console.warn(`[Headless] decrypt worker: MISSING at ${workerFile}, decryption will run on the main thread`)
  if (!existsSync(path.join(webDir, 'index.html'))) console.warn(`[Headless] web UI not found in ${webDir} (set DEEMIX_WEB_DIR)`)
  if (!auth) console.warn('[Headless] WARNING: password protection is DISABLED (DEEMIX_INSECURE_NO_AUTH=1).')

  let stopping = false
  const shutdown = async (signal: string) => {
    if (stopping) return
    stopping = true
    console.log(`[Headless] ${signal} received, shutting down`)
    events.close()
    server.stop()
    await Promise.allSettled([playlistSync.shutdown(), artistSync.shutdown()])
    process.exit(0)
  }
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('SIGINT', () => void shutdown('SIGINT'))
}

main().catch(err => fatal(`Startup failed: ${err?.stack || err}`))
