/**
 * Render the panel with the REAL degraded payload.
 *
 * A typecheck proves the props line up; it does not prove the component survives the data. The
 * production payload includes an empty-ish `provider: "unknown"`, a 30002ms timing, and a long
 * multi-line LLM error — exactly the shapes that turn into a crash or a blank cell.
 */
import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { CogneeDiagnosticsPanel } from './cognee-diagnostics'

const payload = {
  status: 'degraded',
  version: '1.6.0-local',
  uptimeSeconds: 254,
  components: [
    { name: 'relational_db', status: 'healthy' as const, provider: 'sqlite', details: null, responseTimeMs: 22 },
    { name: 'graph_db', status: 'healthy' as const, provider: 'kuzu', details: null, responseTimeMs: 7 },
    {
      name: 'llm_provider',
      status: 'degraded' as const,
      provider: 'unknown',
      details: 'API check failed: LLMAPIKeyNotSetError: LLM API key is not set. (Status code: 422)',
      responseTimeMs: 17,
    },
    {
      name: 'embedding_service',
      status: 'degraded' as const,
      provider: 'unknown',
      details: 'Embedding test failed: timed out after 30s.',
      responseTimeMs: 30002,
    },
  ],
}

describe('CogneeDiagnosticsPanel renders the real payload', () => {
  test('renders without throwing and names every component', () => {
    const html = renderToStaticMarkup(<CogneeDiagnosticsPanel diagnostics={payload} />)
    expect(html).toContain('Extraction LLM')
    expect(html).toContain('Embedding service')
    expect(html).toContain('Knowledge graph')
    // The provider and timing must reach the DOM; dropping them would leave the row unexplained.
    expect(html).toContain('sqlite')
    expect(html).toContain('30002ms')
  })

  test('the embedding warning points at the provider prefix, not at "ignore this"', () => {
    // An earlier revision told the operator this probe was a false alarm. It was NOT: a direct curl
    // bypasses litellm, and litellm is where the failure lives. This asserts the retraction holds —
    // a hint that says "probably fine" would send someone away from a real fault.
    //
    // The hint lives inside the row's accordion, so it is absent from closed markup by design. The
    // FIRST version of this test read the closed markup and failed for that reason, which is a
    // reminder that "the string is not in the HTML" can mean "not expanded" rather than "removed".
    // The assertion therefore targets the SOURCE, where presence cannot depend on render state.
    const source = readFileSync(
      join(import.meta.dir, 'cognee-diagnostics.tsx'),
      'utf-8',
    )
    // Strip comments before the negative assertions: the retraction is EXPLAINED in a comment that
    // necessarily quotes the old wording, so a whole-file scan reports the very text it documents.
    // This bit me on the first attempt — the same "matched prose, not code" class this repo
    // catalogues — and the fix is to assert on what reaches the user, not on the file's bytes.
    const codeOnly = source
      .split('\n')
      .map((l) => {
        const t = l.trimStart()
        if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return ''
        const i = l.indexOf('//')
        return i === -1 ? l : l.slice(0, i)
      })
      .join('\n')

    const hint = codeOnly.slice(codeOnly.indexOf("name === 'embedding_service'"))
    expect(hint.slice(0, 1400)).toContain('provider prefix')
    expect(hint.slice(0, 1400)).toContain('curl bypasses litellm')
    // The exact reassurance that was retracted must not come back — in CODE.
    expect(codeOnly).not.toContain('false alarm')
    expect(codeOnly).not.toContain('ignoreLikely')
  })

  test('the summary names the LLM as a WRITE failure, not a reachability problem', () => {
    const html = renderToStaticMarkup(<CogneeDiagnosticsPanel diagnostics={payload} />)
    expect(html).toContain('memory writes will FAIL')
  })

  test('an all-healthy payload reports no problems', () => {
    const html = renderToStaticMarkup(
      <CogneeDiagnosticsPanel
        diagnostics={{ ...payload, status: 'healthy', components: payload.components.slice(0, 2) }}
      />,
    )
    expect(html).toContain('Every dependency reports healthy')
    expect(html).not.toContain('need attention')
  })
})
