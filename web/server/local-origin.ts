import type { IncomingMessage } from "node:http"
import type { Environ } from "../../src/store/paths.ts"

/** Trust only loopback peers and the exact reader origin. Forwarded headers
 * never authorize an arbitrary hostname or another .localhost application. */
export function isLocalReaderRequest(request: IncomingMessage, env: Environ): boolean {
  const peer = request.socket.remoteAddress
  if (peer !== "127.0.0.1" && peer !== "::1" && peer !== "::ffff:127.0.0.1") return false
  const host = request.headers.host ?? ""
  let origin: string
  if (/^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i.test(host)) {
    origin = `http://${host}`
  } else if (env.PORTLESS_URL === "https://agentchats.localhost" &&
      (host === "agentchats.localhost" || host === "agentchats.localhost:443") &&
      request.headers["x-forwarded-proto"] === "https") {
    origin = "https://agentchats.localhost"
  } else {
    return false
  }
  return (!request.headers.origin || request.headers.origin === origin) &&
    request.headers["sec-fetch-site"] !== "cross-site"
}
