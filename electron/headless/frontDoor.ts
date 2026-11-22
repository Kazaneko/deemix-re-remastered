import { mkdir, rename, stat } from 'fs/promises'
import * as https from 'https'
import { basename, join, normalize, resolve, sep } from 'path'
import * as os from 'os'
import type { IncomingMessage, ServerResponse } from 'http'
import type { RemoteAccessHandler } from '../server'
import { RemoteAuth, clientIp, isSameOrigin, isSecureRequest } from './auth'
import type { EventHub } from './events'
import type { StaticSite } from './static'
import type { HeadlessStorage, Credentials } from './storage'

const MAX_BODY = 32 * 1024 * 1024 // downloads history can be large
export const TRASH_DIR = '.deemix-trash'

// The renderer calls Deezer's public API straight from the page. Electron allows
// that; a normal browser doesn't (api.deezer.com sends no CORS headers), so in
// web mode those calls come here and the server makes them instead.
export const DEEZER_PROXY_PREFIX = '/headless/deezer-api/'
const DEEZER_API_HOST = 'api.deezer.com'
const DEEZER_PROXY_MAX = 10 * 1024 * 1024
const SAFE_API_PATH = /^[A-Za-z0-9/_.-]*$/

export interface FrontDoorOptions {
  auth: RemoteAuth | null // null only with DEEMIX_INSECURE_NO_AUTH=1
  storage: HeadlessStorage
  events: EventHub
  site: StaticSite
  /** Folders the UI may pick and delete inside (the mounted music volumes). */
  musicRoots: string[]
  /** Current download root, never deletable itself. */
  downloadRoot: () => string
  version: string
  trustProxy: boolean
}

/**
 * The headless server's front door (see DeemixServer.setRemoteAccess):
 *  - /headless/session, /headless/login: public
 *  - /api/*, /res/*, /info-spotify, /headless/*: require the session cookie
 *  - everything else: the web UI (public static files; holds no secrets)
 */
export class HeadlessFrontDoor implements RemoteAccessHandler {
  constructor(private readonly o: FrontDoorOptions) {}

  async handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    const path = url.pathname
    const method = req.method || 'GET'
    const secure = isSecureRequest(req, this.o.trustProxy)

    if (method !== 'GET' && method !== 'HEAD' && !isSameOrigin(req)) {
      return this.json(res, 403, { error: 'Cross-origin request refused' })
    }

    if (path === '/headless/session' && method === 'GET') {
      return this.json(res, 200, { authenticated: this.isAuthed(req), authRequired: !!this.o.auth, version: this.o.version })
    }
    if (path === '/headless/login' && method === 'POST') {
      if (!this.o.auth) return this.json(res, 200, { success: true })
      const body = await this.body(req, res)
      if (body === undefined) return true
      const result = this.o.auth.login(body?.password, clientIp(req, this.o.trustProxy), secure)
      if (result.ok) {
        res.setHeader('Set-Cookie', result.cookie)
        return this.json(res, 200, { success: true })
      }
      if (result.reason === 'rate-limited') {
        res.setHeader('Retry-After', String(result.retryAfterSec ?? 60))
        return this.json(res, 429, { success: false, error: 'rate-limited' })
      }
      return this.json(res, 401, { success: false, error: 'invalid' })
    }
    if (path === '/headless/logout' && method === 'POST') {
      if (this.o.auth) res.setHeader('Set-Cookie', this.o.auth.clearCookie(secure))
      return this.json(res, 200, { success: true })
    }

    const isBackend = path.startsWith('/api/') || path.startsWith('/res/') || path === '/info-spotify' || path.startsWith('/headless/')
    if (!isBackend) {
      if (method !== 'GET' && method !== 'HEAD') return this.json(res, 405, { error: 'Method not allowed' })
      await this.o.site.serve(path, res)
      return true
    }

    if (!this.isAuthed(req)) {
      // The header tells the web UI this is *our* 401 (log in again), not a
      // Deezer/Qobuz auth error relayed by the API, which also uses 401.
      res.setHeader('X-Deemix-Auth', 'required')
      return this.json(res, 401, { error: 'Authentication required' })
    }

    if (!path.startsWith('/headless/')) return false // authenticated: on to the normal API

    return this.headlessRoute(req, res, path, method)
  }

  private isAuthed(req: IncomingMessage): boolean {
    return !this.o.auth || this.o.auth.isAuthenticated(req)
  }

  private async headlessRoute(req: IncomingMessage, res: ServerResponse, path: string, method: string): Promise<boolean> {
    if (path.startsWith(DEEZER_PROXY_PREFIX) && method === 'GET') {
      return this.proxyDeezer(req, res)
    }
    if (path === '/headless/events' && method === 'GET') {
      this.o.events.attach(res)
      return true
    }
    if (path === '/headless/info' && method === 'GET') {
      return this.json(res, 200, {
        version: this.o.version,
        musicRoots: this.o.musicRoots,
        runtime: { electron: '-', chromium: '-', node: process.versions.node, v8: process.versions.v8, os: `${os.type()} ${os.release()}` }
      })
    }
    if (method !== 'POST') return this.json(res, 405, { error: 'Method not allowed' })

    const body = await this.body(req, res)
    if (body === undefined) return true
    const s = this.o.storage

    try {
      switch (path) {
        case '/headless/storage/saveCredentials':
          await s.saveCredentials((body?.credentials ?? {}) as Credentials)
          return this.json(res, 200, { success: true })
        case '/headless/storage/loadCredentials':
          return this.json(res, 200, { success: true, credentials: await s.loadCredentials() })
        case '/headless/storage/saveSettings':
          await s.saveSettings(body?.settings ?? {})
          return this.json(res, 200, { success: true })
        case '/headless/storage/loadSettings':
          return this.json(res, 200, { success: true, settings: await s.loadSettings() })
        case '/headless/storage/saveProfiles':
          await s.saveProfiles(body?.data ?? {})
          return this.json(res, 200, { success: true })
        case '/headless/storage/loadProfiles':
          return this.json(res, 200, { success: true, data: await s.loadProfiles() })
        case '/headless/storage/saveDownloadsState':
          await s.saveDownloadsState(body?.state ?? {})
          return this.json(res, 200, { success: true })
        case '/headless/storage/loadDownloadsState':
          return this.json(res, 200, { state: await s.loadDownloadsState() })
        case '/headless/select-folder':
          return this.json(res, 200, { path: await this.checkFolder(body?.path) })
        case '/headless/delete-path':
          return this.json(res, 200, await this.deletePath(body?.path))
        default:
          return this.json(res, 404, { error: 'Not found' })
      }
    } catch (e: any) {
      console.error('[Headless] Route failed:', path, e?.message ?? e)
      return this.json(res, 500, { success: false, error: 'Internal error' })
    }
  }

  /** GET-only relay to https://api.deezer.com/<path>?<query>; nothing else is reachable. */
  private proxyDeezer(req: IncomingMessage, res: ServerResponse): Promise<true> {
    const raw = req.url || ''
    const q = raw.indexOf('?')
    const apiPath = (q < 0 ? raw : raw.slice(0, q)).slice(DEEZER_PROXY_PREFIX.length)
    const query = q < 0 ? '' : raw.slice(q)
    if (!SAFE_API_PATH.test(apiPath) || apiPath.includes('..')) {
      return Promise.resolve(this.json(res, 400, { error: 'Invalid API path' }))
    }
    return new Promise<true>(done => {
      const upstream = https.get({
        host: DEEZER_API_HOST,
        path: `/${apiPath}${query}`,
        headers: { Accept: 'application/json', 'Accept-Language': String(req.headers['accept-language'] || 'en') },
        timeout: 15_000
      }, up => {
        const chunks: Buffer[] = []
        let size = 0
        up.on('data', (c: Buffer) => {
          size += c.length
          if (size > DEEZER_PROXY_MAX) { up.destroy(new Error('Response too large')); return }
          chunks.push(c)
        })
        up.on('end', () => {
          const body = Buffer.concat(chunks)
          res.writeHead(up.statusCode || 502, {
            'Content-Type': String(up.headers['content-type'] || 'application/json'),
            'Content-Length': body.length,
            'Cache-Control': 'no-store'
          })
          res.end(body)
          done(true)
        })
        up.on('error', () => done(this.json(res, 502, { error: 'Deezer API unavailable' })))
      })
      upstream.on('timeout', () => upstream.destroy(new Error('timeout')))
      upstream.on('error', () => done(this.json(res, 502, { error: 'Deezer API unavailable' })))
    })
  }

  /** Normalized folder if it exists and sits inside a music root, else null. */
  async checkFolder(input: unknown): Promise<string | null> {
    if (typeof input !== 'string' || !input.trim() || input.includes('\0')) return null
    const target = normalize(resolve(input.trim()))
    if (!this.insideRoots(target, true)) return null
    try {
      return (await stat(target)).isDirectory() ? target : null
    } catch {
      return null
    }
  }

  /**
   * Recoverable delete, like the desktop app's move-to-trash: the item moves to
   * `<music root>/.deemix-trash/<timestamp>-<name>`. Never the root itself.
   */
  async deletePath(input: unknown): Promise<{ success: boolean; error?: string }> {
    if (typeof input !== 'string' || !input || input.includes('\0') || input.includes('..')) {
      return { success: false, error: 'Invalid path' }
    }
    const target = normalize(resolve(input))
    const root = this.o.musicRoots.map(r => normalize(resolve(r))).find(r => target.startsWith(withSep(r)))
    if (!root) return { success: false, error: 'Path not allowed for deletion' }
    const downloadRoot = normalize(resolve(this.o.downloadRoot() || root))
    if (target === downloadRoot) return { success: false, error: 'Cannot delete the download folder itself' }
    const trash = join(root, TRASH_DIR)
    if (target === trash || target.startsWith(withSep(trash))) return { success: false, error: 'Already in the trash' }
    try {
      await stat(target)
      await mkdir(trash, { recursive: true })
      await rename(target, join(trash, `${Date.now()}-${basename(target)}`))
      return { success: true }
    } catch (e: any) {
      return { success: false, error: `Could not move to trash: ${e?.message ?? e}` }
    }
  }

  private insideRoots(target: string, allowRoot: boolean): boolean {
    return this.o.musicRoots.some(r => {
      const root = normalize(resolve(r))
      return (allowRoot && target === root) || target.startsWith(withSep(root))
    })
  }

  private body(req: IncomingMessage, res: ServerResponse): Promise<any | undefined> {
    return new Promise(resolvePromise => {
      const chunks: Buffer[] = []
      let size = 0
      let done = false
      req.on('data', (c: Buffer) => {
        if (done) return
        size += c.length
        if (size > MAX_BODY) {
          done = true
          this.json(res, 413, { error: 'Request too large' })
          req.destroy()
          resolvePromise(undefined)
          return
        }
        chunks.push(c)
      })
      req.on('end', () => {
        if (done) return
        done = true
        const raw = Buffer.concat(chunks).toString('utf-8')
        if (!raw) return resolvePromise({})
        try {
          resolvePromise(JSON.parse(raw))
        } catch {
          this.json(res, 400, { error: 'Invalid JSON' })
          resolvePromise(undefined)
        }
      })
      req.on('error', () => {
        if (!done) { done = true; resolvePromise(undefined) }
      })
    })
  }

  private json(res: ServerResponse, status: number, data: unknown): true {
    if (!res.headersSent) {
      res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
    }
    res.end(JSON.stringify(data))
    return true
  }
}

function withSep(p: string): string {
  return p.endsWith(sep) ? p : p + sep
}
