import * as crypto from 'crypto'
import { readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import type { IncomingMessage } from 'http'

/**
 * Password gate for the headless server.
 *
 * One shared password (DEEMIX_PASSWORD). A successful login sets an HttpOnly,
 * SameSite=Strict cookie holding `v1.<expiresAt>.<hmac>`. The HMAC key is
 * derived from a random per-install secret (kept in the data folder) AND the
 * password, so changing the password logs every browser out. No session table:
 * restarts keep people logged in, and there is nothing to leak but the secret.
 */

export const SESSION_COOKIE = 'deemix_session'
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000

// Failed logins per client IP: at most 10 per 15 minutes.
const FAIL_WINDOW_MS = 15 * 60 * 1000
const MAX_FAILS = 10

export type LoginResult =
  | { ok: true; cookie: string }
  | { ok: false; reason: 'invalid' | 'rate-limited'; retryAfterSec?: number }

export class RemoteAuth {
  private readonly key: Buffer
  private readonly passwordDigest: Buffer
  private readonly fails = new Map<string, { count: number; resetAt: number }>()

  constructor(password: string, secret: Buffer) {
    if (!password) throw new Error('RemoteAuth needs a non-empty password')
    this.passwordDigest = sha256(password)
    this.key = crypto.createHmac('sha256', secret).update('deemix-session-v1').update(this.passwordDigest).digest()
  }

  /** Load or create the per-install secret in `dataDir`. */
  static loadSecret(dataDir: string): Buffer {
    const file = join(dataDir, 'session-secret')
    try {
      const existing = readFileSync(file)
      if (existing.length >= 32) return existing
    } catch { /* first run */ }
    mkdirSync(dataDir, { recursive: true, mode: 0o700 })
    const secret = crypto.randomBytes(48)
    writeFileSync(file, secret, { mode: 0o600 })
    return secret
  }

  login(password: unknown, clientIp: string, secure: boolean, now = Date.now()): LoginResult {
    const record = this.fails.get(clientIp)
    if (record && now < record.resetAt && record.count >= MAX_FAILS) {
      return { ok: false, reason: 'rate-limited', retryAfterSec: Math.ceil((record.resetAt - now) / 1000) }
    }
    const ok = typeof password === 'string' && crypto.timingSafeEqual(sha256(password), this.passwordDigest)
    if (!ok) {
      if (!record || now >= record.resetAt) this.fails.set(clientIp, { count: 1, resetAt: now + FAIL_WINDOW_MS })
      else record.count++
      this.pruneFails(now)
      return { ok: false, reason: 'invalid' }
    }
    this.fails.delete(clientIp)
    return { ok: true, cookie: this.sessionCookie(this.issueToken(now), secure) }
  }

  issueToken(now = Date.now()): string {
    const expiresAt = now + SESSION_TTL_MS
    return `v1.${expiresAt}.${this.sign(expiresAt)}`
  }

  verifyToken(token: string | undefined, now = Date.now()): boolean {
    if (!token) return false
    const parts = token.split('.')
    if (parts.length !== 3 || parts[0] !== 'v1') return false
    const expiresAt = Number(parts[1])
    if (!Number.isFinite(expiresAt) || expiresAt <= now) return false
    const expected = Buffer.from(this.sign(expiresAt))
    const given = Buffer.from(parts[2])
    return expected.length === given.length && crypto.timingSafeEqual(expected, given)
  }

  isAuthenticated(req: IncomingMessage, now = Date.now()): boolean {
    return this.verifyToken(parseCookies(req.headers.cookie)[SESSION_COOKIE], now)
  }

  sessionCookie(token: string, secure: boolean): string {
    return [
      `${SESSION_COOKIE}=${token}`,
      'Path=/',
      'HttpOnly',
      'SameSite=Strict',
      `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
      ...(secure ? ['Secure'] : [])
    ].join('; ')
  }

  clearCookie(secure: boolean): string {
    return [`${SESSION_COOKIE}=`, 'Path=/', 'HttpOnly', 'SameSite=Strict', 'Max-Age=0', ...(secure ? ['Secure'] : [])].join('; ')
  }

  private sign(expiresAt: number): string {
    return crypto.createHmac('sha256', this.key).update(String(expiresAt)).digest('base64url')
  }

  private pruneFails(now: number): void {
    if (this.fails.size < 1000) return
    for (const [ip, r] of this.fails) if (now >= r.resetAt) this.fails.delete(ip)
  }
}

function sha256(value: string): Buffer {
  return crypto.createHash('sha256').update(value, 'utf8').digest()
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  if (!header) return out
  for (const part of header.split(';')) {
    const i = part.indexOf('=')
    if (i < 0) continue
    const name = part.slice(0, i).trim()
    if (!name) continue
    try { out[name] = decodeURIComponent(part.slice(i + 1).trim()) } catch { out[name] = part.slice(i + 1).trim() }
  }
  return out
}

/** True when the browser reached us over HTTPS (directly or via a reverse proxy). */
export function isSecureRequest(req: IncomingMessage, trustProxy: boolean): boolean {
  if ((req.socket as any).encrypted) return true
  if (!trustProxy) return false
  const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase()
  return proto === 'https'
}

/**
 * Cross-site request guard for state-changing requests. SameSite=Strict already
 * keeps the cookie off cross-site requests; this also rejects any request whose
 * Origin header names a different host than the one it was sent to.
 */
export function isSameOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin
  if (!origin) return true // same-origin GET/HEAD and non-browser clients send none
  const host = req.headers['x-forwarded-host'] || req.headers.host
  if (!host) return false
  try {
    return new URL(origin).host === String(host).split(',')[0].trim()
  } catch {
    return false
  }
}

export function clientIp(req: IncomingMessage, trustProxy: boolean): string {
  if (trustProxy) {
    const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()
    if (fwd) return fwd
  }
  return req.socket.remoteAddress || 'unknown'
}
