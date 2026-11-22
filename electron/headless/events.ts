import type { ServerResponse } from 'http'

/**
 * Server-sent events: the headless replacement for mainWindow.webContents.send.
 * Every connected browser gets every event as `{ channel, data }`, on the same
 * channel names electron/preload.ts listens to (auth:expired, sync:progress...).
 */
export class EventHub {
  private readonly clients = new Set<ServerResponse>()
  private readonly heartbeat: NodeJS.Timeout

  constructor(heartbeatMs = 25_000) {
    // Comment lines keep proxies and idle-timeouts from closing the stream.
    this.heartbeat = setInterval(() => this.write(': ping\n\n'), heartbeatMs)
    this.heartbeat.unref()
  }

  get size(): number {
    return this.clients.size
  }

  attach(res: ServerResponse): void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    })
    res.write('retry: 3000\n\n')
    this.clients.add(res)
    res.on('close', () => this.clients.delete(res))
  }

  send(channel: string, data: unknown): void {
    let payload: string
    try {
      payload = JSON.stringify({ channel, data })
    } catch {
      return
    }
    this.write(`data: ${payload}\n\n`)
  }

  close(): void {
    clearInterval(this.heartbeat)
    for (const res of this.clients) res.end()
    this.clients.clear()
  }

  private write(chunk: string): void {
    for (const res of this.clients) {
      try { res.write(chunk) } catch { this.clients.delete(res) }
    }
  }
}
