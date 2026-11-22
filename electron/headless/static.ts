import { readFile, stat } from 'fs/promises'
import { extname, join, normalize, sep } from 'path'
import type { ServerResponse } from 'http'

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8'
}

/** Marker the renderer looks for to switch into web mode (src/web/webBridge.ts). */
export const HEADLESS_META = '<meta name="deemix-headless" content="1">'

/**
 * Serves the built renderer (dist/) as a single-page app. Unknown non-file paths
 * fall back to index.html; the app itself uses hash routing, so this only
 * matters for hand-typed URLs.
 */
export class StaticSite {
  private indexHtml: Buffer | null = null

  constructor(private readonly root: string) {}

  /** Resolve `urlPath` inside the site root; null if it escapes the root. */
  resolvePath(urlPath: string): string | null {
    let decoded: string
    try {
      decoded = decodeURIComponent(urlPath.split('?')[0])
    } catch {
      return null
    }
    if (decoded.includes('\0')) return null
    const full = normalize(join(this.root, decoded))
    const rootWithSep = this.root.endsWith(sep) ? this.root : this.root + sep
    if (full !== this.root && !full.startsWith(rootWithSep)) return null
    return full
  }

  async serve(urlPath: string, res: ServerResponse): Promise<void> {
    if (urlPath === '/' || urlPath === '/index.html') return this.serveIndex(res)

    const file = this.resolvePath(urlPath)
    if (!file) {
      res.writeHead(400)
      res.end()
      return
    }
    try {
      const info = await stat(file)
      if (info.isFile()) {
        const body = await readFile(file)
        const immutable = urlPath.startsWith('/assets/') // Vite hashes these file names
        res.writeHead(200, {
          'Content-Type': MIME[extname(file).toLowerCase()] || 'application/octet-stream',
          'Content-Length': body.length,
          'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache'
        })
        res.end(body)
        return
      }
    } catch { /* not a file: SPA fallback below */ }

    if (extname(urlPath)) {
      res.writeHead(404)
      res.end()
      return
    }
    return this.serveIndex(res)
  }

  private async serveIndex(res: ServerResponse): Promise<void> {
    if (!this.indexHtml) {
      const html = await readFile(join(this.root, 'index.html'), 'utf-8')
      // Tell the renderer it runs in a browser against the headless server.
      this.indexHtml = Buffer.from(html.replace(/<head>/i, `<head>\n    ${HEADLESS_META}`))
    }
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': this.indexHtml.length,
      'Cache-Control': 'no-cache'
    })
    res.end(this.indexHtml)
  }
}
