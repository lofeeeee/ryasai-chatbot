/**
 * GET + PUT + DELETE /api/llm-config/memory — the memory sidecar's own extraction provider.
 *
 * WHY THIS FILE EXISTS, and why it is separate from the chat route's tests: this route stores a
 * SECOND billable secret and, unlike the chat one, it also PUSHES that secret to another process.
 * Three properties matter more than the field plumbing:
 *
 *   1. THE KEY NEVER LEAVES. GET returns a masked view; the serialised response is scanned for the
 *      plaintext, because one `NextResponse.json(row)` regression hands a live key to any viewer.
 *   2. A BLANK apiKey ON UPDATE ROTATES NOTHING. The form does not echo the stored key, so it submits
 *      empty; treating that as "clear the key" would silently break extraction on an unrelated edit.
 *   3. DELETING THE ROW RE-PUSHES. The sidecar keeps credentials IN MEMORY, so a delete that did not
 *      push would leave the removed model extracting until the next container restart — the "clear it
 *      and nothing changes" failure this feature would otherwise inherit.
 *
 * Also pinned: "no memory row" is reported as source `chat` (follow chat), never as an error and never
 * as `memory`; the provider whitelist; admin-only writes; and that the push result reaches the client
 * so a dropped endpoint is reported rather than claimed as success.
 */
import { describe, expect, test, beforeEach, mock } from 'bun:test'

const adminUser = {
  userId: 'admin-1',
  name: 'Admin',
  email: 'a@t.com',
  role: 'admin',
  organizationId: 'org-1',
  plan: null,
}

const PLAINTEXT_KEY = 'sk-memory-SUPERSECRET-0987654321'

let activeUser: { role: string } = adminUser
let memoryRow: Record<string, unknown> | null = null
let pushResult: Record<string, unknown> = { ok: true, detail: 'Shared openai/m at https://m.example/v1', source: 'memory' }

const createArgs: Array<Record<string, unknown>> = []
const updateArgs: Array<Record<string, unknown>> = []
const deleteArgs: Array<Record<string, unknown>> = []
const auditWrites: Array<Record<string, unknown>> = []
const enteredOrgs: string[] = []
const encrypted: Array<Record<string, unknown>> = []
let pushCalls = 0
/**
 * When true, the mocked decryptor throws. Needed because the mock would otherwise ALWAYS succeed, which
 * makes the route's degradation branch unreachable and its test unable to fail — a guard that cannot
 * fail is worse than no guard.
 */
let decryptThrows = false

mock.module('@/lib/session', () => ({
  getActiveUser: async () => activeUser,
  requireRole: (user: { role: string }, role: string) => {
    if (user.role !== role) {
      const e = new Error('Forbidden') as Error & { statusCode?: number }
      e.statusCode = 403
      throw e
    }
  },
  writeAudit: async (row: Record<string, unknown>) => {
    auditWrites.push(row)
  },
  handleApiError: (e: unknown, msg: string) =>
    Response.json({ error: msg }, { status: (e as { statusCode?: number })?.statusCode ?? 500 }),
}))

mock.module('@/lib/prisma-tenant', () => ({
  enterWithOrg: (orgId: string) => {
    enteredOrgs.push(orgId)
  },
  getOrgContext: () => 'org-1',
}))

mock.module('@/lib/crypto', () => ({
  encryptConfig: (obj: Record<string, unknown>) => {
    encrypted.push(obj)
    return `enc:${Buffer.from(JSON.stringify(obj)).toString('base64url')}`
  },
  decryptConfig: () => {
    if (decryptThrows) throw new Error('Unsupported state or unable to authenticate data')
    return { apiKey: PLAINTEXT_KEY }
  },
}))

mock.module('@/lib/llm-config', () => ({
  normalizeBaseUrl: (raw: string) => {
    const s = String(raw ?? '').trim()
    if (!s) return ''
    if (!/^https?:\/\//i.test(s)) throw new Error('Base URL must start with http:// or https://')
    return s.replace(/\/+$/, '')
  },
  maskSecret: () => 'sk-m••••••••',
  // The route reads the memory row through this resolver, so the mock must honour it — a bare
  // `findFirst` here would make the two callers disagree about which row is authoritative.
  resolveMemoryConfigRow: async () => memoryRow,
}))

mock.module('@/lib/cognee-config-push', () => ({
  pushCogneeProviderConfig: async () => {
    pushCalls += 1
    return pushResult
  },
}))

mock.module('@/lib/db', () => ({
  db: {
    llmConfig: {
      create: async (args: Record<string, unknown>) => {
        createArgs.push(args)
        return {}
      },
      update: async (args: Record<string, unknown>) => {
        updateArgs.push(args)
        return {}
      },
      delete: async (args: Record<string, unknown>) => {
        deleteArgs.push(args)
        return {}
      },
    },
  },
}))

import { GET, PUT, DELETE } from './route'

function put(body: unknown) {
  return PUT(
    new Request('http://localhost/api/llm-config/memory', {
      method: 'PUT',
      body: typeof body === 'string' ? body : JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
    }) as never,
  )
}

const validBody = {
  provider: 'OPENAI_COMPATIBLE',
  baseUrl: 'https://memory.example.com/v1',
  apiKey: PLAINTEXT_KEY,
  model: 'memory-model',
}

beforeEach(() => {
  activeUser = adminUser
  memoryRow = null
  pushResult = { ok: true, detail: 'Shared openai/m at https://m.example/v1', source: 'memory' }
  createArgs.length = 0
  updateArgs.length = 0
  deleteArgs.length = 0
  auditWrites.length = 0
  enteredOrgs.length = 0
  encrypted.length = 0
  pushCalls = 0
  decryptThrows = false
})

describe('GET /api/llm-config/memory — which config memory would actually use', () => {
  test('NO memory row reports source chat, and null — not an error and not an empty config', async () => {
    /*
     * THE UPGRADE STATE, and the one most installs are in. `source: 'chat'` means memory follows the
     * chat provider and works today. Reporting an error here would tell an operator their memory is
     * broken when it is fine; reporting `source: 'memory'` would claim a dedicated model that does
     * not exist.
     */
    memoryRow = null
    const body = (await (await GET()).json()) as { ok: boolean; data: Record<string, unknown> }
    expect(body.ok).toBe(true)
    expect(body.data.memory).toBeNull()
    expect(body.data.source).toBe('chat')
  })

  test('a dedicated row reports source memory with the stored fields masked', async () => {
    memoryRow = {
      provider: 'OPENAI_COMPATIBLE',
      baseUrl: 'https://memory.example.com/v1',
      model: 'memory-model',
      encryptedApiKey: 'enc-whatever',
    }
    const body = (await (await GET()).json()) as { data: Record<string, unknown> }
    expect(body.data.source).toBe('memory')
    expect((body.data.memory as Record<string, unknown>).model).toBe('memory-model')
    expect((body.data.memory as Record<string, unknown>).apiKeyMasked).not.toBe(PLAINTEXT_KEY)
  })

  test('THE PLAINTEXT KEY NEVER CROSSES THE WIRE, in any shape', async () => {
    // Scanned on the serialised body rather than on a field: a regression that returned the row
    // wholesale would pass a field-level assertion while leaking the credential.
    memoryRow = {
      provider: 'OPENAI_COMPATIBLE',
      baseUrl: 'https://memory.example.com/v1',
      model: 'memory-model',
      encryptedApiKey: 'enc-whatever',
    }
    const text = await (await GET()).text()
    expect(text).not.toContain(PLAINTEXT_KEY)
    expect(text).not.toContain('enc-whatever')
  })

  test('an undecryptable key degrades to a mask, never to ciphertext and never to a crash', async () => {
    // The same degradation the chat view performs: the screen must still render, and what it renders
    // must not be the envelope. Driven by a THROWING decryptor — without that, the mock always
    // succeeds and this branch is unreachable.
    decryptThrows = true
    memoryRow = {
      provider: 'OPENAI_COMPATIBLE',
      baseUrl: 'https://memory.example.com/v1',
      model: 'memory-model',
      encryptedApiKey: 'not-decryptable',
    }
    const body = (await (await GET()).json()) as { ok: boolean; data: Record<string, unknown> }
    expect(body.ok).toBe(true)
    expect((body.data.memory as Record<string, unknown>).apiKeyMasked).toBe('••••')
  })

  test('GET enters the session org and is available to any active user', async () => {
    await GET()
    expect(enteredOrgs).toContain('org-1')
  })
})

describe('PUT /api/llm-config/memory — saving a dedicated provider', () => {
  test('the row is created with purpose memory, so it cannot be confused with chat', async () => {
    // `purpose` is the only discriminator on this table and the unique key is (organizationId,
    // purpose). A row created without it would collide with the chat row on the second save.
    await put(validBody)
    expect(createArgs).toHaveLength(1)
    const data = (createArgs[0] as { data: Record<string, unknown> }).data
    expect(data.purpose).toBe('memory')
    expect(data.organizationId).toBe('org-1')
  })

  test('a blank apiKey on update keeps the stored one instead of clearing it', async () => {
    memoryRow = { id: 'm1', provider: 'OPENAI_COMPATIBLE', baseUrl: 'https://old/v1', model: 'old', encryptedApiKey: 'enc-old' }
    await put({ ...validBody, apiKey: '' })
    expect(updateArgs).toHaveLength(1)
    const data = (updateArgs[0] as { data: Record<string, unknown> }).data
    expect('encryptedApiKey' in data).toBe(false)
  })

  test('a blank apiKey on FIRST create is refused with 400, not stored keyless', async () => {
    memoryRow = null
    const res = await put({ ...validBody, apiKey: '' })
    expect(res.status).toBe(400)
    expect(createArgs).toHaveLength(0)
    expect(pushCalls).toBe(0)
  })

  test('the plaintext key is encrypted before it reaches the database', async () => {
    /*
     * ASSERTED ON THE STORED PAYLOAD, NOT ON A CALL LOG. The first version of this test checked that
     * the mocked `encryptConfig` had been called — which a route that CALLS the encryptor and then
     * stores the plaintext anyway would still pass. NEGATIVE CONTROL: replacing the stored value with
     * the raw key left that version green, so it was guarding nothing. This reads what was written.
     */
    await put(validBody)
    const data = (createArgs[0] as { data: Record<string, unknown> }).data
    const stored = String(data.encryptedApiKey)
    expect(stored).not.toContain(PLAINTEXT_KEY)
    expect(stored.startsWith('enc:')).toBe(true)
    // And it decrypts back to the key, so the assertions above cannot pass on junk either.
    const envelope = stored.slice('enc:'.length)
    expect(JSON.parse(Buffer.from(envelope, 'base64url').toString())).toEqual({ apiKey: PLAINTEXT_KEY })
  })

  test('an UPDATE encrypts too, not only the create path', async () => {
    // Two write paths, and only the create one was covered. A route that encrypted on create and
    // stored the raw key on update would leak on every key ROTATION — the path an operator uses most.
    memoryRow = { id: 'm1', provider: 'OPENAI_COMPATIBLE', baseUrl: 'https://old/v1', model: 'old', encryptedApiKey: 'enc-old' }
    await put({ ...validBody, apiKey: 'sk-rotated-SECRET-2222' })
    const data = (updateArgs[0] as { data: Record<string, unknown> }).data
    const stored = String(data.encryptedApiKey)
    expect(stored).not.toContain('sk-rotated-SECRET-2222')
    expect(stored.startsWith('enc:')).toBe(true)
  })

  test('an UNKNOWN provider is not persisted verbatim', async () => {
    await put({ ...validBody, provider: 'evil-provider' })
    const data = (createArgs[0] as { data: Record<string, unknown> }).data
    expect(data.provider).toBe('OPENAI_COMPATIBLE')
  })

  test('a base URL with the wrong scheme is refused, and nothing is written', async () => {
    const res = await put({ ...validBody, baseUrl: 'ftp://nope/v1' })
    expect(res.status).toBe(400)
    expect(createArgs).toHaveLength(0)
  })

  test('an EMPTY base URL is refused with a message that names the alternative', async () => {
    // Not merely invalid: the operator's other option — clear the memory config and follow chat — is
    // the thing they probably want, and a bare "required" would not say so.
    const res = await put({ ...validBody, baseUrl: '' })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string }
    expect(body.error).toContain('delete the memory configuration')
    expect(createArgs).toHaveLength(0)
  })

  test('a missing model is refused rather than stored blank', async () => {
    const res = await put({ ...validBody, model: '   ' })
    expect(res.status).toBe(400)
    expect(createArgs).toHaveLength(0)
  })

  test('saving PUSHES to the sidecar, so the model takes effect now rather than at the next restart', async () => {
    await put(validBody)
    expect(pushCalls).toBe(1)
  })

  test('the push result reaches the client, including the endpoint gap', async () => {
    /*
     * The dropped-endpoint case, which is the one that must not be reported as a clean success:
     * cognee's settings API carries provider/model/key only, so an operator whose gateway is not
     * api.openai.com needs the `.env.cognee` line. Swallowing this would send them away believing
     * memory works.
     */
    pushResult = {
      ok: true,
      detail: 'Shared openai/memory-model at https://memory.example.com/v1',
      source: 'memory',
      endpointNeedsEnv: true,
      endpointValue: 'https://memory.example.com/v1',
    }
    const body = (await (await put(validBody)).json()) as { data: { push: Record<string, unknown> } }
    expect(body.data.push.endpointNeedsEnv).toBe(true)
    expect(body.data.push.endpointValue).toBe('https://memory.example.com/v1')
  })

  test('a FAILED push does not fail the save — the row is written and the gap is reported', async () => {
    // Memory is optional; a sidecar outage must not block a configuration write. The save succeeded,
    // so the response is 200 with push.ok false rather than an error the operator would retry blindly.
    pushResult = { ok: false, detail: 'Sidecar unreachable.', error: 'Could not reach the memory sidecar.' }
    const res = await put(validBody)
    expect(res.status).toBe(200)
    expect(createArgs).toHaveLength(1)
    const body = (await res.json()) as { data: { push: { ok: boolean } } }
    expect(body.data.push.ok).toBe(false)
  })

  test('an audit row is written WITHOUT the key', async () => {
    await put(validBody)
    const detail = auditWrites[0] as { detail: Record<string, unknown> }
    expect(detail.detail.purpose).toBe('memory')
    expect(detail.detail.keyRotated).toBe(true)
    expect(JSON.stringify(detail.detail)).not.toContain(PLAINTEXT_KEY)
  })

  test('a non-admin is refused before any read, write or push', async () => {
    activeUser = { role: 'viewer' }
    const res = await put(validBody)
    expect(res.status).toBe(403)
    expect(createArgs).toHaveLength(0)
    expect(updateArgs).toHaveLength(0)
    expect(pushCalls).toBe(0)
  })

  test('PUT enters the session org before touching the database', async () => {
    await put(validBody)
    expect(enteredOrgs).toContain('org-1')
  })
})

describe('DELETE /api/llm-config/memory — go back to following chat', () => {
  test('it deletes ONLY the memory row and reports source chat', async () => {
    memoryRow = { id: 'm1', provider: 'OPENAI_COMPATIBLE', baseUrl: 'https://m/v1', model: 'm', encryptedApiKey: 'e' }
    const body = (await (await DELETE()).json()) as { data: Record<string, unknown> }
    expect(deleteArgs).toEqual([{ where: { id: 'm1' } }])
    expect(body.data.source).toBe('chat')
    expect(body.data.memory).toBeNull()
    expect(body.data.cleared).toBe(true)
  })

  test('it RE-PUSHES, so the sidecar stops using the removed credentials immediately', async () => {
    /*
     * THE FAILURE THIS PREVENTS. cognee holds credentials in memory only. A delete that skipped the
     * push would leave the old model extracting until the container restarted, and the screen would
     * say "following Chat Configuration" while memory kept using the deleted one.
     */
    memoryRow = { id: 'm1', provider: 'OPENAI_COMPATIBLE', baseUrl: 'https://m/v1', model: 'm', encryptedApiKey: 'e' }
    await DELETE()
    expect(pushCalls).toBe(1)
  })

  test('deleting when there is nothing to delete is a no-op, not an error', async () => {
    memoryRow = null
    const body = (await (await DELETE()).json()) as { ok: boolean; data: Record<string, unknown> }
    expect(body.ok).toBe(true)
    expect(body.data.cleared).toBe(false)
    expect(deleteArgs).toHaveLength(0)
    // Still pushes: the safety-net case, where the sidecar may hold credentials this app no longer
    // has a row for. Skipping it would leave that stale model in place.
    expect(pushCalls).toBe(1)
  })

  test('a non-admin is refused and deletes nothing', async () => {
    activeUser = { role: 'viewer' }
    memoryRow = { id: 'm1', provider: 'OPENAI_COMPATIBLE', baseUrl: 'https://m/v1', model: 'm', encryptedApiKey: 'e' }
    const res = await DELETE()
    expect(res.status).toBe(403)
    expect(deleteArgs).toHaveLength(0)
    expect(pushCalls).toBe(0)
  })
})
