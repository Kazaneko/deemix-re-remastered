import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import * as fs from 'fs'
import * as http from 'http'
import * as os from 'os'
import * as path from 'path'
import { AddressInfo } from 'net'
import { RemoteAuth, SESSION_COOKIE, isSameOrigin, parseCookies } from '../electron/headless/auth'
import { HeadlessStorage, decodeCredential } from '../electron/headless/storage'
import { EventHub } from '../electron/headless/events'
import { StaticSite, HEADLESS_META } from '../electron/headless/static'
import { HeadlessFrontDoor, TRASH_DIR } from '../electron/headless/frontDoor'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'deemix-headless-'))
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }))

const SECRET = Buffer.alloc(48, 7)

describe('RemoteAuth', () => {
  test('accepts the password and issues a verifiable cookie', () => {
    const auth = new RemoteAuth('correct horse', SECRET)
    const r = auth.login('correct horse', '1.1.1.1', false)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.cookie).toContain('HttpOnly')
    expect(r.cookie).toContain('SameSite=Strict')
    expect(r.cookie).not.toContain('Secure')
    const token = parseCookies(r.cookie.split(';')[0])[SESSION_COOKIE]
    expect(auth.verifyToken(token)).toBe(true)
  })

  test('marks the cookie Secure over HTTPS', () => {
    const r = new RemoteAuth('correct horse', SECRET).login('correct horse', '1.1.1.1', true)
    expect(r.ok && r.cookie.includes('Secure')).toBe(true)
  })

  test('rejects wrong passwords, tampered and expired tokens', () => {
    const auth = new RemoteAuth('correct horse', SECRET)
    expect(auth.login('wrong', '2.2.2.2', false).ok).toBe(false)
    expect(auth.login(undefined, '2.2.2.2', false).ok).toBe(false)
    const token = auth.issueToken()
    const [v, exp, sig] = token.split('.')
    expect(auth.verifyToken(`${v}.${Number(exp) + 1}.${sig}`)).toBe(false)
    expect(auth.verifyToken(`${v}.${exp}.${sig.slice(0, -1)}A`)).toBe(false)
    expect(auth.verifyToken(token, Number(exp) + 1)).toBe(false)
    expect(auth.verifyToken(undefined)).toBe(false)
  })

  test('changing the password invalidates existing sessions', () => {
    const token = new RemoteAuth('old password', SECRET).issueToken()
    expect(new RemoteAuth('new password', SECRET).verifyToken(token)).toBe(false)
  })

  test('rate-limits repeated failures per IP, even with the right password', () => {
    const auth = new RemoteAuth('correct horse', SECRET)
    for (let i = 0; i < 10; i++) expect(auth.login('nope', '3.3.3.3', false).ok).toBe(false)
    const blocked = auth.login('correct horse', '3.3.3.3', false)
    expect(blocked.ok).toBe(false)
    expect(!blocked.ok && blocked.reason).toBe('rate-limited')
    expect(auth.login('correct horse', '4.4.4.4', false).ok).toBe(true)
  })

  test('persists one secret per data folder', () => {
    const dir = path.join(tmp, 'secret')
    const a = RemoteAuth.loadSecret(dir)
    const b = RemoteAuth.loadSecret(dir)
    expect(a.equals(b)).toBe(true)
    expect(fs.statSync(path.join(dir, 'session-secret')).mode & 0o777).toBe(0o600)
  })
})

describe('HeadlessStorage', () => {
  test('round-trips credentials in the desktop fallback format, files 0600', async () => {
    const dir = path.join(tmp, 'storage')
    const s = new HeadlessStorage(dir)
    await s.init()
    await s.saveCredentials({ arl: 'a'.repeat(192), spotifyClientId: 'id' })
    expect(await s.loadCredentials()).toEqual({ arl: 'a'.repeat(192), spotifyClientId: 'id' })
    const raw = JSON.parse(fs.readFileSync(s.credentialsPath, 'utf8'))
    expect(raw.arl.obfuscated).toBe(true)
    expect(raw.arl.data).not.toContain('aaaa')
    expect(fs.statSync(s.credentialsPath).mode & 0o777).toBe(0o600)

    await s.saveCredentials({ spotifyClientId: '' }) // empty string removes, others untouched
    expect(await s.loadCredentials()).toEqual({ arl: 'a'.repeat(192) })
  })

  test('cannot read desktop keychain-encrypted values (returns empty, never ciphertext)', () => {
    expect(decodeCredential({ data: 'Y2lwaGVy', encrypted: true })).toBe('')
    expect(decodeCredential({ data: 'plain' })).toBe('plain')
    expect(decodeCredential(undefined)).toBe('')
  })

  test('settings, profiles and downloads state', async () => {
    const s = new HeadlessStorage(path.join(tmp, 'storage2'))
    expect(await s.loadSettings()).toBeNull()
    await s.saveSettings({ quality: 'FLAC' })
    expect(await s.loadSettings()).toEqual({ quality: 'FLAC' })
    await s.saveDownloadsState({ downloads: [{ id: 1 }], downloadHistory: 'bad' as any })
    expect(await s.loadDownloadsState()).toEqual({ downloads: [{ id: 1 }], downloadHistory: [] })
  })
})

describe('isSameOrigin', () => {
  const req = (headers: Record<string, string>) => ({ headers } as unknown as http.IncomingMessage)
  test('allows same host or no Origin, refuses others', () => {
    expect(isSameOrigin(req({ host: '192.168.1.5:6595' }))).toBe(true)
    expect(isSameOrigin(req({ host: '192.168.1.5:6595', origin: 'http://192.168.1.5:6595' }))).toBe(true)
    expect(isSameOrigin(req({ host: '192.168.1.5:6595', origin: 'http://evil.example' }))).toBe(false)
    expect(isSameOrigin(req({ host: '192.168.1.5:6595', origin: 'null' }))).toBe(false)
  })
})

describe('HeadlessFrontDoor over HTTP', () => {
  const web = path.join(tmp, 'web')
  const music = path.join(tmp, 'music')
  const events = new EventHub(60_000)
  let base = ''
  let server: http.Server
  let cookie = ''

  beforeAll(async () => {
    fs.mkdirSync(path.join(web, 'assets'), { recursive: true })
    fs.writeFileSync(path.join(web, 'index.html'), '<!doctype html><html><head><title>x</title></head><body></body></html>')
    fs.writeFileSync(path.join(web, 'assets', 'app-123.js'), 'console.log(1)')
    fs.mkdirSync(path.join(music, 'Artist', 'Album'), { recursive: true })
    fs.writeFileSync(path.join(music, 'Artist', 'Album', '01.flac'), 'x')

    const door = new HeadlessFrontDoor({
      auth: new RemoteAuth('correct horse', SECRET),
      storage: new HeadlessStorage(path.join(tmp, 'door-data')),
      events,
      site: new StaticSite(web),
      musicRoots: [music],
      downloadRoot: () => music,
      version: '9.9.9',
      trustProxy: false
    })
    // Stand-in for DeemixServer: anything the door passes on is "the API".
    server = http.createServer(async (req, res) => {
      const url = new URL(req.url || '/', 'http://x')
      if (await door.handle(req, res, url)) return
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ api: url.pathname }))
    })
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  afterAll(() => {
    events.close()
    server.close()
  })

  const post = (p: string, body: unknown, extra: Record<string, string> = {}) =>
    fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...extra }, body: JSON.stringify(body) })
  const get = (p: string) => fetch(base + p, { headers: cookie ? { Cookie: cookie } : {} })

  test('serves the web UI publicly, with the headless marker and SPA fallback', async () => {
    const index = await (await get('/')).text()
    expect(index).toContain(HEADLESS_META)
    expect(await (await get('/some/route')).text()).toContain(HEADLESS_META)
    const asset = await get('/assets/app-123.js')
    expect(asset.status).toBe(200)
    expect(asset.headers.get('cache-control')).toContain('immutable')
    expect((await get('/missing.js')).status).toBe(404)
    // Traversal attempts stay inside the web root (here: SPA fallback, never the real file).
    const traversal = await (await get('/%2e%2e/%2e%2e/etc/passwd')).text()
    expect(traversal).not.toContain('root:')
    expect(traversal).toContain(HEADLESS_META)
    expect(new StaticSite(web).resolvePath('/../../etc/passwd')).toBeNull()
    expect(new StaticSite(web).resolvePath('/a\0b')).toBeNull()
  })

  test('blocks the API and headless routes without a session, marked as ours', async () => {
    const res = await get('/api/health')
    expect(res.status).toBe(401)
    expect(res.headers.get('x-deemix-auth')).toBe('required')
    expect((await get('/res/x.png')).status).toBe(401)
    expect((await post('/headless/storage/loadSettings', {})).status).toBe(401)
    expect(await (await get('/headless/session')).json()).toEqual({ authenticated: false, authRequired: true, version: '9.9.9' })
  })

  test('wrong password is refused; right password opens the API', async () => {
    expect((await post('/headless/login', { password: 'nope' })).status).toBe(401)
    const ok = await post('/headless/login', { password: 'correct horse' })
    expect(ok.status).toBe(200)
    cookie = (ok.headers.get('set-cookie') || '').split(';')[0]
    expect(cookie.startsWith(`${SESSION_COOKIE}=v1.`)).toBe(true)
    expect(await (await get('/api/health')).json()).toEqual({ api: '/api/health' })
    expect((await get('/headless/session').then(r => r.json())).authenticated).toBe(true)
  })

  test('refuses cross-origin writes even with the cookie', async () => {
    const res = await post('/headless/storage/saveSettings', { settings: {} }, { Origin: 'http://evil.example' })
    expect(res.status).toBe(403)
  })

  test('storage round trip over HTTP', async () => {
    await post('/headless/storage/saveSettings', { settings: { quality: 'FLAC' } })
    expect(await (await post('/headless/storage/loadSettings', {})).json()).toEqual({ success: true, settings: { quality: 'FLAC' } })
    await post('/headless/storage/saveCredentials', { credentials: { arl: 'secret-arl' } })
    expect((await (await post('/headless/storage/loadCredentials', {})).json()).credentials).toEqual({ arl: 'secret-arl' })
  })

  test('folder picker only accepts existing folders inside the music roots', async () => {
    const pick = async (p: string) => (await (await post('/headless/select-folder', { path: p })).json()).path
    expect(await pick(path.join(music, 'Artist'))).toBe(path.join(music, 'Artist'))
    expect(await pick(music)).toBe(music)
    expect(await pick('/etc')).toBeNull()
    expect(await pick(path.join(music, 'nope'))).toBeNull()
    expect(await pick(path.join(music, 'Artist', 'Album', '01.flac'))).toBeNull()
  })

  test('delete moves into the trash inside the root, never the root itself', async () => {
    const del = async (p: string) => (await post('/headless/delete-path', { path: p })).json()
    expect((await del(music)).success).toBe(false)
    expect((await del('/etc/hosts')).success).toBe(false)
    expect((await del(path.join(music, '..', 'x'))).success).toBe(false)
    const album = path.join(music, 'Artist', 'Album')
    expect((await del(album)).success).toBe(true)
    expect(fs.existsSync(album)).toBe(false)
    const trashed = fs.readdirSync(path.join(music, TRASH_DIR))
    expect(trashed.some(n => n.endsWith('-Album'))).toBe(true)
  })

  test('server-sent events reach logged-in browsers', async () => {
    const controller = new AbortController()
    const res = await fetch(base + '/headless/events', { headers: { Cookie: cookie }, signal: controller.signal })
    expect(res.headers.get('content-type')).toContain('text/event-stream')
    const reader = res.body!.getReader()
    await new Promise(r => setTimeout(r, 50))
    events.send('sync:progress', { playlistId: '42', current: 1 })
    let text = ''
    const deadline = Date.now() + 2000
    while (!text.includes('sync:progress') && Date.now() < deadline) {
      const { value, done } = await reader.read()
      if (done) break
      text += new TextDecoder().decode(value)
    }
    controller.abort()
    expect(text).toContain('"channel":"sync:progress"')
    expect(text).toContain('"playlistId":"42"')
  })

  test('Deezer API relay: auth required, only plain API paths', async () => {
    const res401 = await fetch(base + '/headless/deezer-api/search?q=a')
    expect(res401.status).toBe(401)
    expect((await get('/headless/deezer-api/%2F%2Fevil.example/x')).status).toBe(400)
    expect((await get('/headless/deezer-api/a@evil.example')).status).toBe(400)
  })

  test('logout clears the cookie', async () => {
    const res = await post('/headless/logout', {})
    expect(res.headers.get('set-cookie')).toContain('Max-Age=0')
  })
})
