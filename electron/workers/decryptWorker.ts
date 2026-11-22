/**
 * Worker thread entry: decrypts Deezer tracks off the Electron main process.
 *
 * Built by vite-plugin-electron to dist-electron/decryptWorker.js (see
 * vite.config.ts) and driven by electron/services/decryptPool.ts. Each message
 * is one job; the worker stays alive between jobs so the pool can reuse it.
 */
import { parentPort } from 'worker_threads'
import { decryptTrackFile } from '../services/deezerDecrypt'

export interface DecryptJobMessage {
  id: number
  inputPath: string
  sngId: string
  outputPath: string
}

export interface DecryptResultMessage {
  id: number
  ok: boolean
  error?: string
}

/** Sent once, after this module (and its imports) loaded successfully. */
export interface DecryptReadyMessage {
  ready: true
}

const port = parentPort
if (!port) {
  throw new Error('decryptWorker must be started as a worker thread')
}

port.on('message', (job: DecryptJobMessage) => {
  let result: DecryptResultMessage
  try {
    decryptTrackFile(job.inputPath, job.sngId, job.outputPath)
    result = { id: job.id, ok: true }
  } catch (e: any) {
    result = { id: job.id, ok: false, error: e?.message ?? String(e) }
  }
  port.postMessage(result)
})

const ready: DecryptReadyMessage = { ready: true }
port.postMessage(ready)
