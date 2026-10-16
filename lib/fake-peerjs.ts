import { BrowserContext, WebSocketRoute } from '@playwright/test'
import { installLocalWebRTC } from './local-webrtc'

/**
 * A fake PeerJS signaling server in place of the PeerJS cloud
 * (0.peerjs.com), which edrys.js uses for `Edrys.sendStream` /
 * `Edrys.onStream` with the `webrtc` method unless `peerServerConfig` is set.
 *
 * Only the signaling is faked: offers, answers and candidates are relayed
 * between the browsers of a test, and the media then flows over a real
 * WebRTC connection between them. One server is shared by all contexts of a
 * test, so create it per test and install it in every context:
 *
 *   const peerjs = new FakePeerServer()
 *   const prepare = (context) => peerjs.install(context)
 *   peerjs.ids()   // peers connected right now
 *   peerjs.dropMediaAnswers = true  // media calls never connect (failed ICE)
 *
 * Mirrors the parts of the PeerJS server protocol the client relies on:
 * OPEN on connect, ID-TAKEN for an id held by another token, `src` added to
 * relayed messages, messages for an unknown peer queued and answered with
 * EXPIRE after 5 s (the client turns that into a `peer-unavailable` error).
 *
 * It also keeps ICE on this machine (`installLocalWebRTC`, see local-webrtc.ts).
 */

const CLOUD = /^wss:\/\/0\.peerjs\.com(:443)?\/peerjs\?/
const CLOUD_ID = /^https:\/\/0\.peerjs\.com(:443)?\/peerjs\/id/
const EXPIRE_MS = 5000

interface Client {
  ws: WebSocketRoute
  token: string
}

interface Queued {
  src: string
  message: any
  timer: ReturnType<typeof setTimeout>
}

export class FakePeerServer {
  private clients = new Map<string, Client>()
  private queue = new Map<string, Queued[]>()

  /**
   * Drop the answers to media calls, so the media connection never comes up,
   * as when ICE fails behind a strict NAT or firewall. The receiving side
   * still gets its `stream` event, because the remote tracks come with the offer.
   */
  dropMediaAnswers = false

  /** Ids of the peers connected right now. */
  ids(): string[] {
    return [...this.clients.keys()]
  }

  /** Context hook: route this context's PeerJS cloud traffic to this server. */
  async install(context: BrowserContext) {
    await context.route(CLOUD_ID, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'text/plain',
        headers: { 'Access-Control-Allow-Origin': '*' },
        body: crypto.randomUUID(),
      })
    )
    await context.routeWebSocket(CLOUD, (ws) => this.connect(ws))
    await installLocalWebRTC(context)
  }

  /** Stop every pending timer (call in afterEach). */
  close() {
    for (const list of this.queue.values()) list.forEach((q) => clearTimeout(q.timer))
    this.queue.clear()
    this.clients.clear()
  }

  private send(ws: WebSocketRoute, message: any) {
    try {
      ws.send(JSON.stringify(message))
    } catch {
      // the page went away
    }
  }

  private connect(ws: WebSocketRoute) {
    const params = new URL(ws.url()).searchParams
    const id = params.get('id') || ''
    const token = params.get('token') || ''

    const holder = this.clients.get(id)
    if (holder && holder.token !== token) {
      this.send(ws, { type: 'ID-TAKEN', payload: { msg: 'ID is taken' } })
      ws.close()
      return
    }
    this.clients.set(id, { ws, token })
    this.send(ws, { type: 'OPEN' })

    // deliver what was sent to this id before it connected
    const waiting = this.queue.get(id) || []
    this.queue.delete(id)
    for (const q of waiting) {
      clearTimeout(q.timer)
      this.send(ws, { ...q.message, src: q.src })
    }

    ws.onMessage((raw) => {
      let message: any
      try {
        message = JSON.parse(String(raw))
      } catch {
        return
      }
      if (message.type === 'HEARTBEAT' || !message.dst) return
      this.relay(id, message)
    })

    ws.onClose(() => {
      if (this.clients.get(id)?.ws === ws) this.clients.delete(id)
    })
  }

  private relay(src: string, message: any) {
    // a media call whose answer is lost: the caller never connects, while the
    // callee already has the remote tracks (they arrive with the offer)
    if (this.dropMediaAnswers && message.type === 'ANSWER' && message.payload?.type === 'media') return
    const dst = this.clients.get(message.dst)
    if (dst) {
      this.send(dst.ws, { ...message, src })
      return
    }
    if (message.type === 'LEAVE' || message.type === 'EXPIRE') return

    const list = this.queue.get(message.dst) || []
    const entry: Queued = {
      src,
      message,
      timer: setTimeout(() => {
        const rest = (this.queue.get(message.dst) || []).filter((q) => q !== entry)
        if (rest.length) this.queue.set(message.dst, rest)
        else this.queue.delete(message.dst)
        const sender = this.clients.get(src)
        if (sender && message.type === 'OFFER') {
          this.send(sender.ws, { type: 'EXPIRE', src: message.dst, dst: src })
        }
      }, EXPIRE_MS),
    }
    list.push(entry)
    this.queue.set(message.dst, list)
  }
}
