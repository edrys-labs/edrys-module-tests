import { BrowserContext, WebSocketRoute } from '@playwright/test'

/**
 * A fake of the Edrys WebSocket stream relay (`websocket-server`, endpoint
 * `/stream`), used by `Edrys.sendStream` / `Edrys.onStream` with
 * `method: 'websocket'`. Shared by all contexts of a test:
 *
 *   const relay = new FakeStreamRelay()
 *   await relay.install(context)       // in every context's prepare
 *   stationConfig: { streamMethod: 'websocket', websocketUrl: relay.url }
 *   relay.rooms()                      // roomId -> { source, viewers, chunks }
 *
 * Same protocol as websocket-server/src/stream-utils.js: a source sends
 * `register-source` (roomId, mimeType) and then binary chunks; a viewer sends
 * `join-room`. Viewers get `source-available` (with the mimeType) when a source
 * registers or when they join a room that has one; the source gets
 * `viewer-joined` so it restarts its recorder. Chunks go to every viewer of
 * the source's room.
 */

interface Socket {
  ws: WebSocketRoute
  roomId?: string
  isSource?: boolean
  mimeType?: string
}

export class FakeStreamRelay {
  readonly url = 'ws://stream-relay.e2e.test/stream'
  private sockets = new Set<Socket>()
  private sources = new Map<string, Socket>()
  private chunks = new Map<string, number>()

  /** Per room: whether a source is registered, how many viewers, how many chunks were relayed. */
  rooms(): Record<string, { source: boolean; viewers: number; chunks: number }> {
    const out: Record<string, { source: boolean; viewers: number; chunks: number }> = {}
    for (const s of this.sockets) {
      if (!s.roomId) continue
      out[s.roomId] ??= { source: false, viewers: 0, chunks: this.chunks.get(s.roomId) || 0 }
      if (s.isSource) out[s.roomId].source = true
      else out[s.roomId].viewers++
    }
    return out
  }

  /** Context hook: route this context's sockets to `url` to this relay. */
  async install(context: BrowserContext) {
    await context.routeWebSocket(this.url, (ws) => this.connect(ws))
  }

  private json(s: Socket, message: any) {
    try {
      s.ws.send(JSON.stringify(message))
    } catch {
      // the page went away
    }
  }

  private connect(ws: WebSocketRoute) {
    const socket: Socket = { ws }
    this.sockets.add(socket)

    ws.onMessage((message) => {
      if (typeof message !== 'string') {
        if (socket.isSource && socket.roomId) this.relay(socket, message)
        return
      }
      let data: any
      try {
        data = JSON.parse(message)
      } catch {
        return
      }
      if (data.type === 'register-source' && data.roomId) {
        socket.isSource = true
        socket.roomId = data.roomId
        socket.mimeType = data.mimeType
        this.sources.set(data.roomId, socket)
        this.json(socket, { type: 'source-registered', roomId: data.roomId })
        for (const s of this.sockets) {
          if (s !== socket && !s.isSource && s.roomId === data.roomId) {
            this.json(s, { type: 'source-available', roomId: data.roomId, mimeType: data.mimeType })
          }
        }
      } else if (data.type === 'join-room' && data.roomId) {
        socket.roomId = data.roomId
        const source = this.sources.get(data.roomId)
        if (source) {
          this.json(socket, { type: 'source-available', roomId: data.roomId, mimeType: source.mimeType })
          this.json(source, { type: 'viewer-joined', roomId: data.roomId })
        }
      }
    })

    ws.onClose(() => {
      this.sockets.delete(socket)
      if (socket.isSource && socket.roomId && this.sources.get(socket.roomId) === socket) {
        this.sources.delete(socket.roomId)
      }
    })
  }

  private relay(source: Socket, chunk: Buffer) {
    const roomId = source.roomId!
    this.chunks.set(roomId, (this.chunks.get(roomId) || 0) + 1)
    for (const s of this.sockets) {
      if (s !== source && !s.isSource && s.roomId === roomId) {
        try {
          s.ws.send(chunk)
        } catch {
          // the page went away
        }
      }
    }
  }
}
