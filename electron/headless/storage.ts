import { chmod, mkdir, readFile, rename, writeFile } from 'fs/promises'
import { join } from 'path'
import type { StoredCredential } from '../serverBootstrap'

/**
 * Headless counterpart of the storage:* IPC handlers in electron/main.ts.
 * Same file names and on-disk format, so a data folder can move between the
 * desktop app and the server.
 *
 * There is no OS keychain in a container, so credentials use the desktop app's
 * own fallback format (base64, reversed: obfuscation, not encryption). The real
 * protection is that every file is written 0600 inside a data volume only the
 * container user can read. Values the desktop app encrypted with its keychain
 * cannot be read here and come back empty (the user enters them again).
 */

export const CREDENTIAL_KEYS = [
  'arl', 'spotifyClientId', 'spotifyClientSecret', 'spotifyUsername',
  'qobuzUserId', 'qobuzToken', 'qobuzAppId', 'qobuzAppSecret'
] as const

export type CredentialKey = typeof CREDENTIAL_KEYS[number]
export type Credentials = Partial<Record<CredentialKey, string>>

export function decodeCredential(stored: StoredCredential | undefined): string {
  if (!stored || !stored.data) return ''
  if (stored.encrypted) return '' // keychain-encrypted by the desktop app: unreadable here
  if (stored.obfuscated) {
    try {
      return Buffer.from(stored.data.split('').reverse().join(''), 'base64').toString('utf-8')
    } catch {
      return ''
    }
  }
  return stored.data
}

function encodeCredential(value: string): StoredCredential {
  return { data: Buffer.from(value).toString('base64').split('').reverse().join(''), encrypted: false, obfuscated: true }
}

export class HeadlessStorage {
  constructor(private readonly dir: string) {}

  get credentialsPath(): string { return join(this.dir, 'credentials.json') }
  get settingsPath(): string { return join(this.dir, 'settings.json') }
  get profilesPath(): string { return join(this.dir, 'profiles.json') }
  get downloadsStatePath(): string { return join(this.dir, 'downloads-state.json') }

  async init(): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 })
  }

  async saveCredentials(credentials: Credentials): Promise<void> {
    const data: Record<string, StoredCredential> = (await this.readJson(this.credentialsPath)) ?? {}
    for (const key of CREDENTIAL_KEYS) {
      const value = credentials[key]
      if (value === undefined) continue
      if (typeof value !== 'string' || !value) delete data[key]
      else data[key] = encodeCredential(value)
    }
    await this.writeJsonAtomic(this.credentialsPath, data)
  }

  async loadCredentials(): Promise<Credentials> {
    const data: Record<string, StoredCredential> | null = await this.readJson(this.credentialsPath)
    const result: Credentials = {}
    if (!data) return result
    for (const key of CREDENTIAL_KEYS) {
      const value = decodeCredential(data[key])
      if (value) result[key] = value
    }
    return result
  }

  async saveSettings(settings: object): Promise<void> {
    await this.writeJsonAtomic(this.settingsPath, settings)
  }

  async loadSettings(): Promise<object | null> {
    return this.readJson(this.settingsPath)
  }

  async saveProfiles(data: object): Promise<void> {
    await this.writeJsonAtomic(this.profilesPath, data)
  }

  async loadProfiles(): Promise<unknown> {
    return this.readJson(this.profilesPath)
  }

  async saveDownloadsState(state: { downloads?: unknown; downloadHistory?: unknown }): Promise<void> {
    await this.writeJsonAtomic(this.downloadsStatePath, {
      downloads: Array.isArray(state?.downloads) ? state.downloads : [],
      downloadHistory: Array.isArray(state?.downloadHistory) ? state.downloadHistory : []
    })
  }

  async loadDownloadsState(): Promise<{ downloads: unknown[]; downloadHistory: unknown[] } | null> {
    const data: any = await this.readJson(this.downloadsStatePath)
    if (!data || typeof data !== 'object') return null
    return {
      downloads: Array.isArray(data.downloads) ? data.downloads : [],
      downloadHistory: Array.isArray(data.downloadHistory) ? data.downloadHistory : []
    }
  }

  private async readJson<T = any>(file: string): Promise<T | null> {
    try {
      return JSON.parse(await readFile(file, 'utf-8')) as T
    } catch (e: any) {
      if (e?.code !== 'ENOENT') console.error(`[Headless] Failed to read ${file}:`, e?.message ?? e)
      return null
    }
  }

  /** tmp + rename so a crash mid-write never corrupts the only copy. */
  private async writeJsonAtomic(file: string, value: unknown): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 })
    const tmp = `${file}.${process.pid}.tmp`
    await writeFile(tmp, JSON.stringify(value, null, 2), { encoding: 'utf-8', mode: 0o600 })
    await rename(tmp, file)
    await chmod(file, 0o600).catch(() => undefined)
  }
}
