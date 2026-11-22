/**
 * Web mode: the renderer running in a normal browser against the headless
 * server (electron/headless/), instead of inside Electron.
 *
 * - The server marks index.html with <meta name="deemix-headless">.
 * - The app talks to its backend with hand-built `http://127.0.0.1:${port}`
 *   URLs in many places; fetch() and window.open() rewrite those to the page's
 *   own origin so the same code works remotely. Calls to Deezer's public API
 *   (no CORS headers, so a browser would block them) go through the server.
 * - window.electronAPI is provided over HTTP (/headless/*) with server-sent
 *   events, so stores keep their single code path. Features that only make
 *   sense on the desktop (window controls, Deezer/Qobuz login windows, updates)
 *   are left out; the UI already checks for them with optional chaining.
 */
import i18n from '../i18n'

const LOOPBACK = /^https?:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?(?=\/|$)/i
// Deezer's public API sends no CORS headers: relay it through the server.
const DEEZER_API = /^https:\/\/api\.deezer\.com\//i
const DEEZER_PROXY = '/headless/deezer-api/'

export function isHeadlessWeb(): boolean {
  return typeof document !== 'undefined' && !!document.querySelector('meta[name="deemix-headless"]')
}

export function rewriteLoopbackUrl(url: string, origin: string = window.location.origin): string {
  if (LOOPBACK.test(url)) return url.replace(LOOPBACK, origin)
  if (DEEZER_API.test(url)) return url.replace(DEEZER_API, origin + DEEZER_PROXY)
  return url
}

const needsRewrite = (url: string) => LOOPBACK.test(url) || DEEZER_API.test(url)

let fetchInstalled = false

/** Rewrite loopback URLs and return to the login screen when the session ends. */
export function installFetchRewrite(): void {
  if (fetchInstalled) return
  fetchInstalled = true
  const nativeFetch = window.fetch.bind(window)
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    if (typeof input === 'string') input = rewriteLoopbackUrl(input)
    else if (input instanceof URL) input = new URL(rewriteLoopbackUrl(input.href))
    else if (input instanceof Request && needsRewrite(input.url)) input = new Request(rewriteLoopbackUrl(input.url), input)
    const response = await nativeFetch(input, init)
    if (response.status === 401 && response.headers.get('X-Deemix-Auth') === 'required') {
      onSessionLost()
    }
    return response
  }
  const nativeOpen = window.open.bind(window)
  window.open = (url?: string | URL, target?: string, features?: string) =>
    nativeOpen(url === undefined ? url : rewriteLoopbackUrl(String(url)), target, features)
}

let reloading = false
function onSessionLost(): void {
  if (reloading) return
  reloading = true
  window.location.reload() // index boots into the login screen again
}

export interface HeadlessSession {
  authenticated: boolean
  authRequired: boolean
  version: string
}

export async function fetchSession(): Promise<HeadlessSession> {
  const res = await fetch('/headless/session', { credentials: 'same-origin' })
  if (!res.ok) throw new Error(`session check failed: ${res.status}`)
  return res.json()
}

export type LoginOutcome = 'ok' | 'invalid' | 'rate-limited' | 'error'

export async function loginToServer(password: string): Promise<LoginOutcome> {
  try {
    const res = await fetch('/headless/login', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password })
    })
    if (res.ok) return 'ok'
    if (res.status === 429) return 'rate-limited'
    if (res.status === 401) return 'invalid'
    return 'error'
  } catch {
    return 'error'
  }
}

async function post<T = any>(path: string, body: unknown = {}): Promise<T> {
  const res = await fetch(path, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
  if (!res.ok) throw new Error(`${path} failed: ${res.status}`)
  return res.json()
}

type Listener = (data: any) => void
const listeners = new Map<string, Set<Listener>>()
let eventSource: EventSource | null = null

function on(channel: string, cb: Listener): void {
  if (!listeners.has(channel)) listeners.set(channel, new Set())
  listeners.get(channel)!.add(cb)
  if (!eventSource) {
    eventSource = new EventSource('/headless/events', { withCredentials: true })
    eventSource.onmessage = (ev) => {
      try {
        const { channel: ch, data } = JSON.parse(ev.data)
        listeners.get(ch)?.forEach(fn => {
          try { fn(data) } catch (e) { console.error('[WebBridge] listener failed', ch, e) }
        })
      } catch { /* ignore malformed frames */ }
    }
  }
}

interface ServerInfo {
  version: string
  musicRoots: string[]
  runtime: { electron: string; chromium: string; node: string; v8: string; os: string }
}

const t = (key: string, params?: Record<string, unknown>) => i18n.global.t(key, params ?? {})

export function buildWebElectronAPI(info: ServerInfo): Window['electronAPI'] {
  const port = Number(window.location.port) || (window.location.protocol === 'https:' ? 443 : 80)

  const api = {
    minimize: async () => {},
    maximize: async () => {},
    close: async () => {},
    isMaximized: async () => false,
    onMaximizeChange: () => {},

    // No native picker in a browser: ask for a path on the server and check it there.
    selectFolder: async (defaultPath?: string) => {
      const input = window.prompt(t('web.serverFolderPrompt'), defaultPath || info.musicRoots[0] || '')
      if (input === null || !input.trim()) return null
      const { path } = await post<{ path: string | null }>('/headless/select-folder', { path: input })
      if (!path) {
        window.alert(t('web.folderNotFound', { roots: info.musicRoots.join(', ') }))
        return null
      }
      return path
    },
    // Can't open the server's file manager from here; say where the files are.
    openPath: async (path: string) => {
      window.alert(t('web.folderOnServer', { path }))
    },
    openExternal: async (url: string) => {
      window.open(url, '_blank', 'noopener,noreferrer')
    },
    deletePath: async (path: string) => post('/headless/delete-path', { path }),
    // false = let the caller fall back to the browser clipboard API.
    clipboardWriteText: async () => false,

    getVersion: async () => info.version,
    getRuntimeInfo: async () => info.runtime,
    getServerPort: async () => port,

    onAuthExpired: (cb: Listener) => on('auth:expired', cb),
    onQobuzAuthExpired: (cb: Listener) => on('qobuz-auth:expired', cb),
    onSessionHealth: (cb: Listener) => on('session:health', cb),

    // Secrets live on the server (storage.saveCredentials), never in the browser.
    safeStorage: {
      isAvailable: async () => false,
      encrypt: async (plaintext: string) => ({ encrypted: false, data: plaintext }),
      decrypt: async (data: string) => data
    },

    playlistSync: {
      onSyncStart: (cb: Listener) => on('sync:start', cb),
      onSyncProgress: (cb: Listener) => on('sync:progress', cb),
      onSyncComplete: (cb: Listener) => on('sync:complete', cb),
      onSyncError: (cb: Listener) => on('sync:error', cb)
    },
    artistSync: {
      onSyncStart: (cb: Listener) => on('artistSync:start', cb),
      onSyncProgress: (cb: Listener) => on('artistSync:progress', cb),
      onSyncComplete: (cb: Listener) => on('artistSync:complete', cb),
      onSyncError: (cb: Listener) => on('artistSync:error', cb)
    },

    storage: {
      saveCredentials: (credentials: object) => post('/headless/storage/saveCredentials', { credentials }),
      loadCredentials: () => post('/headless/storage/loadCredentials'),
      loadDownloadsState: async () => (await post<{ state: any }>('/headless/storage/loadDownloadsState')).state,
      saveDownloadsState: (state: object) => post('/headless/storage/saveDownloadsState', { state }),
      saveSettings: (settings: object) => post('/headless/storage/saveSettings', { settings }),
      // First run: start from the server's music folder instead of an empty path.
      loadSettings: async () => {
        const result = await post<{ success: boolean; settings: any }>('/headless/storage/loadSettings')
        const settings = result.settings ?? {}
        if (!settings.downloadPath && info.musicRoots[0]) settings.downloadPath = info.musicRoots[0]
        return { success: true, settings }
      },
      saveProfiles: (data: object) => post('/headless/storage/saveProfiles', { data }),
      loadProfiles: () => post('/headless/storage/loadProfiles')
    }
    // deezerLogin, qobuzLogin, updates: desktop only, intentionally absent.
  }
  return api as unknown as Window['electronAPI']
}

/** Fetch server info and install window.electronAPI. Call after login. */
export async function installWebBridge(): Promise<void> {
  const res = await fetch('/headless/info', { credentials: 'same-origin' })
  if (!res.ok) throw new Error(`info failed: ${res.status}`)
  const info: ServerInfo = await res.json()
  ;(window as any).electronAPI = buildWebElectronAPI(info)
}
