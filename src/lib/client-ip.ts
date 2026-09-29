/**
 * The client address, as far as the reverse proxy in front of this install can tell us.
 *
 * WHY THIS EXISTS. `src/middleware.ts` keyed its anonymous rate-limit bucket on the session cookie. A login
 * request has no session cookie by definition, so the key collapsed to the literal `session::/api/auth/login`
 * — ONE bucket for every unauthenticated caller on the install, and it counted SUCCESSES too. Measured: the
 * 11th login inside a single 60-second window came back HTTP 429 with `Retry-After: 60`, which is how this
 * was found (the e2e suite performs 11 logins; the last one failed and the run went red). A limiter needs an
 * identifier the caller cannot share by accident, and for an anonymous request the only one available is the
 * address it arrived from.
 *
 * WHY THE LAST HOP AND NOT THE FIRST. Both proxies this project documents APPEND the real peer to whatever
 * the client sent:
 *   - Caddy: `X-Forwarded-For: <client-supplied values>, <peer that connected>`
 *   - nginx: `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for` — the same shape
 * So the FIRST entry is attacker-controlled: a client sending `X-Forwarded-For: 1.2.3.4` would mint a fresh
 * bucket on every request, i.e. no limit at all. The LAST entry is the address the proxy itself observed.
 * Behind EXACTLY ONE proxy — which is this deployment: the app is published on 127.0.0.1 only — the last
 * entry IS the client. Adding a second proxy in front would make the last entry that proxy and collapse every
 * caller back into one bucket, which is why the constant and this note exist rather than a silent assumption.
 *
 * `X-Real-IP` is the fallback because nginx sets it with `proxy_set_header X-Real-IP $remote_addr`, which
 * OVERWRITES a client-supplied value. It is second, not first, because Caddy does not set it by default and
 * passes unknown headers through, so on a Caddy install it is the spoofable one.
 *
 * WHAT THIS IS NOT: authentication. A caller that can reach the loopback port directly, or that runs on the
 * host, can send any header. This is a bucket key: a forged one buys a fresh bucket, never a bypass of the
 * password check, and the guard it feeds fails closed on its own terms.
 */

/** Returned when neither header is present: one SHARED bucket, deliberately not an unlimited one. */
export const UNKNOWN_CLIENT_IP = 'unknown'

/**
 * Bound on the key placed in a Map. The header is attacker-controlled text, so an unbounded key is an
 * unbounded allocation per request; 64 chars covers an IPv6 literal with room to spare.
 */
const MAX_IP_CHARS = 64

/** Minimal shape shared by a real `Request` and the plain objects test stubs pass. */
export interface ClientIpRequest {
  headers?: { get(name: string): string | null } | null
}

/**
 * Reduces one header value to a bare address: takes the LAST comma-separated hop (see the note above),
 * strips a trailing `:port` — including the bracketed IPv6 form — lowercases, and truncates.
 *
 * Exported so the rules can be pinned directly rather than only through a request object.
 */
export function normalizeClientIp(value: string): string {
  const hops = value.split(',')
  let ip = (hops[hops.length - 1] ?? '').trim().toLowerCase()
  if (ip.startsWith('[')) {
    // [2001:db8::1]:8443 -> 2001:db8::1
    const closing = ip.indexOf(']')
    if (closing > 1) ip = ip.slice(1, closing)
  } else {
    // A SINGLE colon means an IPv4 literal with a port (203.0.113.7:443). A bare IPv6 address has more,
    // so its colons must be left alone.
    const colon = ip.indexOf(':')
    if (colon > 0 && ip.lastIndexOf(':') === colon) ip = ip.slice(0, colon)
  }
  return ip.slice(0, MAX_IP_CHARS)
}

export function getClientIp(req: ClientIpRequest): string {
  // Optional chaining on purpose: test stubs pass objects with no headers at all, and a limiter that throws
  // on those would turn a test gap into a 500 on the login route.
  const forwarded = normalizeClientIp(req.headers?.get?.('x-forwarded-for') ?? '')
  if (forwarded) return forwarded
  const real = normalizeClientIp(req.headers?.get?.('x-real-ip') ?? '')
  if (real) return real
  return UNKNOWN_CLIENT_IP
}
