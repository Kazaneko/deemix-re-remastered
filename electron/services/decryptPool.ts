import { Worker } from 'worker_threads'
import * as os from 'os'
import * as path from 'path'
import { decryptTrackFile } from './deezerDecrypt'
import { bundleDir } from '../runtimePaths'
import type { DecryptJobMessage, DecryptReadyMessage, DecryptResultMessage } from '../workers/decryptWorker'

/**
 * Small pool of long-lived worker threads for Deezer track decryption.
 *
 * Why: decryption is pure-JS Blowfish over the whole file (30–50 MB for FLAC)
 * plus sync read/write. On the main process it froze the local API server, IPC
 * and window events for hundreds of ms to seconds per track, so the UI's
 * progress polling stalled and then caught up in bursts.
 *
 * Safety net: if workers cannot start (bad path, packaging issue) or keep
 * crashing, the pool disables itself and decrypts inline, i.e. exactly the old
 * behaviour. Slower UI, but downloads never break because of this change.
 */

interface PendingJob {
  id: number
  inputPath: string
  sngId: string
  outputPath: string
  attempts: number
  resolve: () => void
  reject: (err: Error) => void
}

const MAX_WORKER_FAILURES = 3
const MAX_JOB_ATTEMPTS = 2

export class DecryptPool {
  private readonly workers = new Set<Worker>()
  private idle: Worker[] = []
  private readonly busy = new Map<Worker, PendingJob>()
  private readonly ready = new WeakSet<Worker>()
  private queue: PendingJob[] = []
  private nextId = 1
  private failures = 0
  private disabled = false

  constructor(
    private readonly workerPath: string,
    private readonly size: number
  ) {}

  /** True once the pool fell back to inline (main-thread) decryption. */
  get isInline(): boolean {
    return this.disabled
  }

  decrypt(inputPath: string, sngId: string, outputPath: string): Promise<void> {
    if (this.disabled) return runInline(inputPath, sngId, outputPath)
    return new Promise<void>((resolve, reject) => {
      this.queue.push({ id: this.nextId++, inputPath, sngId, outputPath, attempts: 0, resolve, reject })
      this.pump()
    })
  }

  async destroy(): Promise<void> {
    const all = [...this.workers]
    this.workers.clear()
    this.idle = []
    for (const [, job] of this.busy) job.reject(new Error('Decrypt pool destroyed'))
    this.busy.clear()
    for (const job of this.queue.splice(0)) job.reject(new Error('Decrypt pool destroyed'))
    await Promise.all(all.map(w => w.terminate().catch(() => undefined)))
  }

  private pump(): void {
    while (this.queue.length > 0 && !this.disabled) {
      let worker = this.idle.pop()
      if (!worker) {
        if (this.workers.size >= this.size) return
        worker = this.spawn() ?? undefined
        if (!worker) return
      }
      const job = this.queue.shift()!
      job.attempts++
      this.busy.set(worker, job)
      worker.ref() // keep the process alive while a job is in flight
      const msg: DecryptJobMessage = {
        id: job.id,
        inputPath: job.inputPath,
        sngId: job.sngId,
        outputPath: job.outputPath
      }
      worker.postMessage(msg)
    }
  }

  private spawn(): Worker | null {
    let worker: Worker
    try {
      worker = new Worker(this.workerPath)
    } catch (err: any) {
      this.disable(err)
      return null
    }
    // Idle workers must not keep the process alive on quit.
    worker.unref()
    this.workers.add(worker)

    worker.on('message', (msg: DecryptResultMessage | DecryptReadyMessage) => {
      if ('ready' in msg) {
        this.ready.add(worker)
        return
      }
      const job = this.busy.get(worker)
      if (!job || job.id !== msg.id) return
      this.busy.delete(worker)
      worker.unref()
      this.failures = 0
      if (msg.ok) job.resolve()
      else job.reject(new Error(msg.error || 'Unknown decryption error'))
      if (this.workers.has(worker)) this.idle.push(worker)
      this.pump()
    })
    worker.on('error', err => this.onWorkerDied(worker, err))
    worker.on('exit', code => this.onWorkerDied(worker, new Error(`Decrypt worker exited with code ${code}`)))
    return worker
  }

  private onWorkerDied(worker: Worker, err: Error): void {
    // 'error' is followed by 'exit'; handle each worker only once.
    if (!this.workers.has(worker)) return
    this.workers.delete(worker)
    this.idle = this.idle.filter(w => w !== worker)

    const job = this.busy.get(worker)
    this.busy.delete(worker)

    // Died before it ever started (missing bundle, asar/packaging problem):
    // retrying would fail the same way, so go inline now and keep the job.
    if (!this.ready.has(worker)) {
      if (job) {
        job.attempts--
        this.queue.unshift(job)
      }
      this.disable(err)
      return
    }

    this.failures++
    console.error(`[DecryptPool] worker died (${this.failures}/${MAX_WORKER_FAILURES}):`, err.message)

    if (job) {
      if (job.attempts >= MAX_JOB_ATTEMPTS) job.reject(new Error(`Decryption worker crashed: ${err.message}`))
      else this.queue.unshift(job)
    }

    if (this.failures >= MAX_WORKER_FAILURES) this.disable(err)
    else this.pump()
  }

  private disable(err: any): void {
    if (this.disabled) return
    this.disabled = true
    console.error(
      '[DecryptPool] worker threads unavailable, falling back to inline decryption (UI may stutter):',
      err?.message ?? err
    )
    for (const job of this.queue.splice(0)) {
      runInline(job.inputPath, job.sngId, job.outputPath).then(job.resolve, job.reject)
    }
  }
}

function runInline(inputPath: string, sngId: string, outputPath: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    setImmediate(() => {
      try {
        decryptTrackFile(inputPath, sngId, outputPath)
        resolve()
      } catch (e: any) {
        reject(e instanceof Error ? e : new Error(String(e)))
      }
    })
  })
}

let sharedPool: DecryptPool | null = null

/**
 * Process-wide pool. The worker bundle sits next to main.js in dist-electron
 * (downloader.ts is bundled into main.js, so __dirname is dist-electron).
 * Size: one worker per spare core, capped at 4 (the downloader runs ≤5 tracks
 * at once and only one phase of each track decrypts).
 */
export function getDecryptPool(): DecryptPool {
  if (!sharedPool) {
    const size = Math.max(1, Math.min(4, os.cpus().length - 1))
    sharedPool = new DecryptPool(path.join(bundleDir(__dirname), 'decryptWorker.js'), size)
  }
  return sharedPool
}
