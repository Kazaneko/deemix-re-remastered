#!/usr/bin/env bun
// Builds the headless server (electron/headless/main.ts) for plain Node:
//   dist-headless/server.js         backend + web front door, all deps bundled
//   dist-headless/decryptWorker.js  decryption worker (decryptPool.ts loads it
//                                   from next to the bundle, as on desktop)
// The web UI itself is the normal renderer build in dist/ (`vite build`).
// Usage: bun scripts/build-headless.ts
import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dir, '..')
const outdir = join(root, 'dist-headless')
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

rmSync(outdir, { recursive: true, force: true })

const entries: Array<[string, string]> = [
  ['electron/headless/main.ts', 'server.js'],
  ['electron/workers/decryptWorker.ts', 'decryptWorker.js']
]

for (const [entry, name] of entries) {
  const result = await Bun.build({
    entrypoints: [join(root, entry)],
    outdir,
    naming: name,
    target: 'node',
    format: 'cjs',
    sourcemap: 'linked',
    define: { __APP_VERSION__: JSON.stringify(version) },
    // Electron must never be pulled in: the backend reaches it only through a
    // lazy require in runtimePaths.ts, which DEEMIX_DATA_DIR short-circuits.
    external: ['electron']
  })
  if (!result.success) {
    for (const log of result.logs) console.error(log)
    process.exit(1)
  }
  console.log(`built ${name}`)
}
