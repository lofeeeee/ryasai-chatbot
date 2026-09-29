import { describe, expect, test } from 'bun:test'
import { getClientIp, normalizeClientIp, UNKNOWN_CLIENT_IP } from './client-ip'

describe('normalizeClientIp — which hop is the client', () => {
  test('takes the LAST hop, because the first is client-supplied', () => {
    // Caddy and nginx both APPEND the peer they observed to whatever the caller sent, so a request carrying
    // `X-Forwarded-For: 1.2.3.4` arrives as `1.2.3.4, <real>`. Keying on the first hop would let an attacker
    // mint a fresh bucket for every request by incrementing the spoofed value, i.e. no limit at all.
    expect(normalizeClientIp('1.2.3.4, 203.0.113.9')).toBe('203.0.113.9')
    expect(normalizeClientIp('1.2.3.4, 5.6.7.8, 203.0.113.9')).toBe('203.0.113.9')
  })

  test('a single hop is returned as-is', () => {
    expect(normalizeClientIp('203.0.113.9')).toBe('203.0.113.9')
  })

  test('strips a :port from an IPv4 literal', () => {
    expect(normalizeClientIp('203.0.113.9:51234')).toBe('203.0.113.9')
  })

  test('leaves a bare IPv6 literal alone — its colons are not a port', () => {
    expect(normalizeClientIp('2001:db8::1')).toBe('2001:db8::1')
  })

  test('unwraps a bracketed IPv6 literal with a port', () => {
    expect(normalizeClientIp('[2001:db8::1]:8443')).toBe('2001:db8::1')
  })

  test('trims and lowercases', () => {
    expect(normalizeClientIp('  2001:DB8::1  ')).toBe('2001:db8::1')
  })

  test('truncates to 64 characters so a header cannot grow the bucket map without bound', () => {
    expect(normalizeClientIp('a'.repeat(200))).toHaveLength(64)
  })

  test('a malformed bracketed value does not throw', () => {
    // Robustness, not a supported format: garbage in a header must never turn a login into a 500.
    expect(() => normalizeClientIp('[2001:db8::1')).not.toThrow()
  })
})

describe('getClientIp — header precedence', () => {
  function withHeaders(headers: Record<string, string>) {
    return { headers: { get: (name: string) => headers[name.toLowerCase()] ?? null } }
  }

  test('prefers X-Forwarded-For', () => {
    expect(getClientIp(withHeaders({ 'x-forwarded-for': '203.0.113.9', 'x-real-ip': '198.51.100.1' }))).toBe('203.0.113.9')
  })

  test('falls back to X-Real-IP when X-Forwarded-For is absent or leaves an empty hop', () => {
    expect(getClientIp(withHeaders({ 'x-real-ip': '198.51.100.1' }))).toBe('198.51.100.1')
    expect(getClientIp(withHeaders({ 'x-forwarded-for': '', 'x-real-ip': '198.51.100.1' }))).toBe('198.51.100.1')
    // A trailing comma leaves an EMPTY last hop; falling through beats keying every such caller on ''.
    expect(getClientIp(withHeaders({ 'x-forwarded-for': '203.0.113.9, ', 'x-real-ip': '198.51.100.1' }))).toBe('198.51.100.1')
  })

  test('returns the SHARED unknown key when no proxy headers exist', () => {
    // Shared, deliberately not unlimited: every direct caller lands in one bucket rather than in none.
    expect(getClientIp(withHeaders({}))).toBe(UNKNOWN_CLIENT_IP)
    expect(getClientIp({})).toBe(UNKNOWN_CLIENT_IP)
    expect(getClientIp({ headers: null })).toBe(UNKNOWN_CLIENT_IP)
  })
})
