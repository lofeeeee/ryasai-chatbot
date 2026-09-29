import { describe, expect, test } from 'bun:test'
import {
  SQL_MAX_LIMIT, RAG_CHUNK_SIZE, RAG_CHUNK_OVERLAP, RAG_MAX_PER_DOCUMENT,
  RAG_CACHE_TTL_MS, RAG_MAX_CHUNKS_PER_UPLOAD,
  RATE_LIMIT_WINDOW_MS, RATE_LIMIT_DEFAULT, RATE_LIMIT_CHAT,
  RATE_LIMIT_LOGIN, RATE_LIMIT_LOGIN_PER_IP, RATE_LIMIT_AGENT, RATE_LIMIT_UPLOAD,
} from './constants'

describe('constants', () => {
  test('SQL_MAX_LIMIT is 100', () => {
    expect(SQL_MAX_LIMIT).toBe(100)
  })

  test('RAG constants have sensible values', () => {
    expect(RAG_CHUNK_SIZE).toBeGreaterThan(100)
    expect(RAG_CHUNK_OVERLAP).toBeGreaterThan(0)
    expect(RAG_CHUNK_OVERLAP).toBeLessThan(RAG_CHUNK_SIZE)
    expect(RAG_MAX_PER_DOCUMENT).toBeGreaterThan(0)
    expect(RAG_CACHE_TTL_MS).toBeGreaterThan(1000)
    expect(RAG_MAX_CHUNKS_PER_UPLOAD).toBeGreaterThan(10)
  })

  test('rate limit constants', () => {
    expect(RATE_LIMIT_WINDOW_MS).toBe(60_000)
    expect(RATE_LIMIT_DEFAULT).toBe(60)
    expect(RATE_LIMIT_CHAT).toBeLessThan(RATE_LIMIT_DEFAULT)
    expect(RATE_LIMIT_LOGIN).toBeLessThanOrEqual(RATE_LIMIT_CHAT)
    expect(RATE_LIMIT_AGENT).toBeGreaterThan(0)
    expect(RATE_LIMIT_UPLOAD).toBeGreaterThan(0)
  })

  test('the ACCOUNT axis is strictest; the ADDRESS axis is deliberately looser', () => {
    // Both axes count FAILED sign-ins, never requests. The account axis is the tight brute-force bound; the
    // address axis only has to cap spraying across many accounts, and an office behind one NAT address
    // shares it, so it must not be as tight as the account axis.
    expect(RATE_LIMIT_LOGIN).toBeLessThanOrEqual(RATE_LIMIT_CHAT)
    expect(RATE_LIMIT_LOGIN).toBeLessThanOrEqual(RATE_LIMIT_DEFAULT)
    expect(RATE_LIMIT_LOGIN_PER_IP).toBeGreaterThan(RATE_LIMIT_LOGIN)
    expect(RATE_LIMIT_LOGIN_PER_IP).toBeLessThanOrEqual(RATE_LIMIT_DEFAULT)
  })
})
