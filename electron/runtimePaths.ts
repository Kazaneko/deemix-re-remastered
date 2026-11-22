import * as path from 'path'

/**
 * Where the backend keeps its state (caches, sync databases, credentials).
 *
 * Desktop: Electron's userData folder, exactly as before.
 * Headless server (electron/headless/main.ts, plain Node, no Electron): the
 * DEEMIX_DATA_DIR environment variable.
 *
 * Electron is required lazily so the headless build never tries to load it.
 * Callers must keep calling this lazily too: app.getPath() only works after
 * Electron's 'ready' event.
 */
let cachedUserDataDir: string | null = null

export function userDataDir(): string {
  if (cachedUserDataDir) return cachedUserDataDir
  const fromEnv = process.env.DEEMIX_DATA_DIR
  if (fromEnv) {
    cachedUserDataDir = path.resolve(fromEnv)
    return cachedUserDataDir
  }
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { app } = require('electron') as typeof import('electron')
  cachedUserDataDir = app.getPath('userData')
  return cachedUserDataDir
}

/**
 * Folder holding the running bundle (main.js on desktop, server.js headless).
 * Bun's bundler bakes __dirname in as the *source* folder at build time, so the
 * headless entry exports the real location in DEEMIX_BUNDLE_DIR; desktop leaves
 * it unset and keeps using the caller's __dirname exactly as before.
 */
export function bundleDir(fallback: string): string {
  return process.env.DEEMIX_BUNDLE_DIR || fallback
}
