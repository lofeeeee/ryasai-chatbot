import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The cognee sidecar's credentials live in `.env.cognee`, and nothing in the compose file may
 * override them.
 *
 * WHY THIS EXISTS. `install.sh` generates the compose `cognee` service, and it used to carry:
 *
 *     - LLM_API_KEY=${COGNEE_LLM_API_KEY:-}
 *     - LLM_MODEL=${COGNEE_LLM_MODEL:-}
 *
 * which looks like "default to unset" but is not. MEASURED precedence in docker compose v5.5.1:
 *
 *   * `env_file: [a, b]`  -> b wins on conflicts; keys unique to either file survive
 *   * `environment:`      -> OVERRIDES env_file, ALWAYS
 *
 * So with cognee's config in an env file and `COGNEE_LLM_API_KEY` unset in the shell, `${...:-}`
 * resolves EMPTY and the override BLANKS the file's value. Reproduced directly: an env file holding
 * `LLM_API_KEY=sk-real-key` still reached the container as `[]`.
 *
 * That made a separate cognee config IMPOSSIBLE while looking supported — the worst combination,
 * because an operator sets a key, sees no effect, and has nothing to read that explains it.
 *
 * WHAT THIS GUARD CHECKS: that the generated `cognee` service overrides none of the variables
 * `.env.cognee` is meant to own. It is a static read of `install.sh`, because the compose file is
 * generated from a heredoc inside that script and never exists on disk in the repo.
 */
describe('cognee: the separate config file is not overridden by compose', () => {
  const root = join(import.meta.dir, '..', '..')
  const installSh = readFileSync(join(root, 'install.sh'), 'utf-8')

  /**
   * Extract the generated compose. Mirrors how the file is built: three heredocs appended in
   * sequence (`cat >` then `cat >>`), so all of them must be concatenated or the YAML is a
   * fragment whose `services:` block may be cut off mid-file.
   */
  function generatedCompose(): string {
    const lines = installSh.split('\n')
    const out: string[] = []
    let i = 0
    while (i < lines.length) {
      const line = lines[i]
      if (
        line.startsWith('cat > docker-compose.prod.yml <<') ||
        line.startsWith('cat >> docker-compose.prod.yml <<')
      ) {
        const end = lines.findIndex((l, j) => j > i && l.trim() === 'EOF')
        if (end === -1) throw new Error('unterminated compose heredoc')
        out.push(...lines.slice(i + 1, end))
        i = end + 1
      } else {
        i += 1
      }
    }
    return out.join('\n')
  }

  /**
   * Extract the `cognee` service block by indentation. A YAML parser would be better, but the
   * heredoc is a TEMPLATE: it contains `${VAR:-default}` which compose interpolates, and parsing it
   * as YAML would either fail or silently accept a fragment.
   */
  function cogneeBlock(compose: string): string {
    const lines = compose.split('\n')
    const start = lines.findIndex((l) => /^ {2}cognee:\s*$/.test(l))
    if (start === -1) throw new Error('cognee service not found in generated compose')
    let end = lines.length
    for (let i = start + 1; i < lines.length; i += 1) {
      // Next top-level service key: exactly two spaces of indent, not a comment.
      if (/^ {2}\S/.test(lines[i]) && !lines[i].trimStart().startsWith('#')) {
        end = i
        break
      }
      if (/^ {2}networks:\s*$/.test(lines[i])) {
        end = i
        break
      }
    }
    return lines.slice(start, end).join('\n')
  }

  /**
   * Strip `#` comments. LOAD-BEARING, and learned from a negative control that FAILED to fail:
   * deleting the `.env.cognee` line from `env_file:` still passed the assertion below, because the
   * surrounding prose comments also contain the string `.env.cognee`. That is the "matched a word,
   * not a call" class this project already catalogues — a comment is not an env_file entry.
   */
  const stripComments = (src: string) =>
    src
      .split('\n')
      .map((line) => {
        const hash = line.indexOf('#')
        return (hash === -1 ? line : line.slice(0, hash)).trimEnd()
      })
      .join('\n')

  const compose = generatedCompose()
  const cognee = cogneeBlock(compose)
  const cogneeCode = stripComments(cognee)

  test('the cognee service lists .env.cognee as an env_file', () => {
    // Negative control on the extraction: if either helper silently returned a fragment, the
    // override assertions below would pass on an empty string.
    expect(cogneeCode.length).toBeGreaterThan(200)
    expect(cogneeCode).toContain('env_file:')
    // The LIST ENTRY, not the string: `- .env.cognee` as its own line under env_file.
    expect(cogneeCode).toMatch(/^\s*-\s*\.env\.cognee\s*$/m)
  })

  test('install.sh always writes .env.cognee, so compose never fails on a missing file', () => {
    // compose fails the ENTIRE `up` when a listed env_file does not exist. One branch writes the
    // skeleton, the other keeps an existing file and refuses to leave it empty — both are required
    // for the env_file line above to be safe.
    expect(installSh).toContain('COGNEE_ENV_FILE=".env.cognee"')
    expect(installSh).toMatch(/\[ -s "\$COGNEE_ENV_FILE" \] \|\| printf/)
  })

  test('nothing in the cognee environment block can blank .env.cognee', () => {
    // The whole defect, as one assertion. `.env.cognee` owns cognee's model credentials; a compose
    // `${VAR:-}` for any of them overrides the file with an empty string.
    const owned = [
      'LLM_PROVIDER',
      'LLM_API_KEY',
      'LLM_ENDPOINT',
      'LLM_MODEL',
      'LLM_ALLOWED_HOSTS',
      'EMBEDDING_PROVIDER',
      'EMBEDDING_API_KEY',
      'EMBEDDING_ENDPOINT',
      'EMBEDDING_MODEL',
      'EMBEDDING_DIMENSIONS',
      'AUTO_FEEDBACK',
      'IMPROVE_AUTO_ENABLED',
    ]
    // `environment:` entries are `- KEY=...`; `env_file:` entries are bare paths. Only the former
    // can override, so scan only lines after the `environment:` key.
    const envIdx = cogneeCode.indexOf('environment:')
    expect(envIdx).toBeGreaterThan(-1)
    const envBlock = cogneeCode.slice(envIdx)
    const offenders = owned.filter((k) => new RegExp(`^\\s*-\\s*${k}=`, 'm').test(envBlock))
    expect(
      offenders,
      `these are set in the cognee service's environment:, so they OVERRIDE .env.cognee with ` +
        `\${VAR:-} (empty when unset) and the file has no effect: ${offenders.join(', ')}`,
    ).toEqual([])
  })

  test('the generated .env.cognee template uses cognee\'s own variable names', () => {
    // The file is handed to the sidecar verbatim, so the name in the file must be the name cognee
    // reads. A `COGNEE_LLM_API_KEY=` line would look right and do nothing.
    const marker = 'cat > "$COGNEE_ENV_FILE" <<'
    const start = installSh.indexOf(marker)
    expect(start).toBeGreaterThan(-1)
    const end = installSh.indexOf('\nCOGNEEEOF', start)
    expect(end).toBeGreaterThan(start)
    const tpl = installSh.slice(start, end)
    for (const key of ['LLM_PROVIDER=', 'LLM_ENDPOINT=', 'LLM_MODEL=', 'LLM_API_KEY=']) {
      expect(tpl, `template must set ${key}`).toContain(`\n${key}`)
    }
    // And it must NOT use the COGNEE_-prefixed names, which the sidecar does not read.
    expect(tpl).not.toContain('\nCOGNEE_LLM_API_KEY=')
    expect(tpl).not.toContain('\nCOGNEE_LLM_MODEL=')
  })

  test('the embedding key stays non-empty in the template', () => {
    // litellm keys off PROVIDER, not ENDPOINT: with provider `openai` and an empty key it ignores
    // EMBEDDING_ENDPOINT and calls api.openai.com, failing every write with "No credentials for
    // provider: openai" — a message that names the wrong cause entirely.
    expect(installSh).toMatch(/^EMBEDDING_API_KEY=.+$/m)
  })
})
