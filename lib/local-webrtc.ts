import { BrowserContext } from '@playwright/test'
import { MODULE_ORIGIN } from './modules'

/**
 * Keep WebRTC between the test browsers on this machine, so media connections
 * between module frames come up every time:
 *
 *   await installLocalWebRTC(context)       // in every context's prepare
 *   test.use({ launchOptions: localWebRTCLaunchOptions })
 *
 * - Module frames get no STUN/TURN servers (host candidates only). With the
 *   public servers edrys-Lite hands out, two browsers on one host sometimes
 *   paired through the NAT's public address, and one direction never answered.
 * - Chromium hides host candidates behind random mDNS names (*.local) on pages
 *   without camera permission. Resolving them between test browsers failed for
 *   about 1 in 8 media connections (stuck in ICE checking); the launch option
 *   turns the hiding off so candidates carry plain local IPs.
 *
 * Both only change the test environment; real classes keep their ICE servers.
 */

/** Context hook: no STUN/TURN servers in module frames. */
export async function installLocalWebRTC(context: BrowserContext) {
  await context.addInitScript(localIce, MODULE_ORIGIN)
}

// Runs in the page; must be self-contained. Host candidates only.
function localIce(moduleOrigin: string) {
  if (location.origin !== moduleOrigin || !window.RTCPeerConnection) return
  const Original = window.RTCPeerConnection
  class LocalPeerConnection extends Original {
    constructor(config: RTCConfiguration = {}) {
      super({ ...config, iceServers: [] })
    }
  }
  window.RTCPeerConnection = LocalPeerConnection as typeof RTCPeerConnection
}

/** For `test.use({ launchOptions })`: Chromium without mDNS host candidates, other browsers unchanged. */
export const localWebRTCLaunchOptions = [
  async ({ browserName }: { browserName: string }, use: (options: object) => Promise<void>) =>
    use(browserName === 'chromium' ? { args: ['--disable-features=WebRtcHideLocalIpsWithMdns'] } : {}),
  { scope: 'worker' },
] as any
