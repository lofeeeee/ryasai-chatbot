/**
 * Render the panel with the REAL degraded payload.
 *
 * A typecheck proves the props line up; it does not prove the component survives the data. The
 * production payload includes an empty-ish `provider: "unknown"`, a 30002ms timing, and a long
 * multi-line LLM error — exactly the shapes that turn into a crash or a blank cell.
 */
import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
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

  test('the warning is honest about the embedding false alarm', () => {
    // The known-flaky probe must be labelled as needing verification, NOT as a proven fault — the
    // whole point of this panel is that an operator can tell the two apart.
    const html = renderToStaticMarkup(<CogneeDiagnosticsPanel diagnostics={payload} />)
    expect(html).toContain('Likely a false alarm')
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
