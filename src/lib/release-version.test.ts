import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * One version, everywhere — including the git TAG that names the release.
 *
 * WHY THIS EXISTS. The version is stamped in eight places, and until 2026-09-25 they had drifted to
 * FOUR different numbers (0.4.0 / 2.0.0 / 0.5.0 / 0.0.0) while the release was called 1.0.0. Nobody
 * noticed because nothing compared them, and the mismatch is not cosmetic: `install.sh` writes
 * `NEXT_PUBLIC_APP_VERSION` into the customer's `.env`, but `NEXT_PUBLIC_*` is substituted at BUILD
 * time and the Dockerfile declares no `ARG` for it — so what the customer's UI actually displays is
 * the hardcoded FALLBACK in `public-config.ts` / `topbar.tsx`. A release whose fallback says 0.4.0
 * ships a product that reports the wrong version to its owner, and a support request quoting
 * "version 0.4.0" cannot be matched to any artifact.
 *
 * THE TAG IS PART OF THE VERSION. `build-images.yml` publishes `:<version>` images when a
 * `v<version>` tag is pushed, so the tag names the artifact. A tag that disagrees with the stamped
 * version produces an image called `:1.1.0` whose UI displays `1.0.0` — two names for one build,
 * and no way to tell which one a customer is running.
 *
 * WHAT THIS GUARD CANNOT SEE. On a `main` push there is no tag, so it validates the eight stamped
 * locations only. On CI for a tag push it additionally checks the tag. It never reaches the
 * registry: whether `:1.0.0` was successfully PUSHED is a different question, answered by the
 * workflow's own "Verify published images resolve" step and by docs/RELEASE.md step 3b.
 */
describe('release: one version across every stamped location', () => {
  const root = join(import.meta.dir, '..', '..')
  const read = (rel: string) => readFileSync(join(root, rel), 'utf-8')

  /**
   * Each entry extracts a version and says WHY that location matters, so a future reader who is
   * tempted to drop one knows what breaks. Extraction is deliberately anchored:
   *
   * `public-config.ts` and `topbar.tsx` also QUOTE the historical drifted values (0.4.0, 2.0.0,
   * 0.5.0) in comments explaining why they were unified. A loose `/[0-9]+\.[0-9]+\.[0-9]+/` match
   * reports 0.4.0 for a file whose real value is 1.0.0 — a false mismatch that trains people to
   * ignore the guard. The patterns below match the ASSIGNMENT, not any version-like string.
   */
  const LOCATIONS: Array<{ file: string; extract: (src: string) => string | null; why: string }> = [
    {
      file: 'package.json',
      extract: (s) => s.match(/"version"\s*:\s*"([^"]+)"/)?.[1] ?? null,
      why: 'the canonical version; npm tooling and `process.env.npm_package_version` read it',
    },
    {
      file: '.env.example',
      extract: (s) => s.match(/^NEXT_PUBLIC_APP_VERSION=(.+)$/m)?.[1]?.trim() ?? null,
      why: 'documents the release and is what install.sh copies the shape of',
    },
    {
      file: 'install.sh',
      extract: (s) => s.match(/^INSTALLER_VERSION="([0-9]+\.[0-9]+\.[0-9]+)"$/m)?.[1] ?? null,
      why: 'the installer\'s single source of truth: written into the customer .env, printed in the update banner, and recorded in .install-manifest',
    },
    {
      file: 'install.sh',
      // A SECOND, independent extraction from the same file. The refactor that introduced
      // `INSTALLER_VERSION` left `NEXT_PUBLIC_APP_VERSION=${INSTALLER_VERSION}` in the generated
      // `.env` template — correct, and invisible to a guard that only reads the constant. This
      // asserts the template INTERPOLATES that constant rather than spelling a number of its own,
      // which is how a literal `1.0.0` could survive a future 1.1.0 bump unnoticed.
      //
      // `:-` is accepted because the template MUST tolerate unset variables: `render_env` is called
      // on the UPDATE path (to list env key names) where the generate branch never ran, and the
      // script uses `set -u`. Without the default the installer aborted with
      // "ENC_KEY: unbound variable" and every update failed — a real outage, fixed by `${VAR:-}`.
      // Pinning only the bare form made this guard fail for the fix that was correct.
      extract: (s) =>
        /^NEXT_PUBLIC_APP_VERSION=\$\{INSTALLER_VERSION:?-?\}$/m.test(s)
          ? (s.match(/^INSTALLER_VERSION="([0-9]+\.[0-9]+\.[0-9]+)"$/m)?.[1] ?? null)
          : null,
      why: 'the generated .env must interpolate INSTALLER_VERSION, not hardcode a number that a future bump would miss',
    },
    {
      file: 'src/lib/public-config.ts',
      extract: (s) => s.match(/appVersion:[^']*'([0-9]+\.[0-9]+\.[0-9]+)'/)?.[1] ?? null,
      why: 'THE DISPLAYED VALUE in the shipped image — the Dockerfile has no ARG, so this fallback is what the customer sees',
    },
    {
      file: 'src/components/views/topbar.tsx',
      extract: (s) => s.match(/NEXT_PUBLIC_APP_VERSION\s*\|\|\s*'([0-9]+\.[0-9]+\.[0-9]+)'/)?.[1] ?? null,
      why: 'the same fallback in the topbar header; a second copy that can drift from public-config',
    },
    {
      file: 'src/lib/otel.ts',
      extract: (s) => s.match(/npm_package_version\s*\?\?\s*'([0-9]+\.[0-9]+\.[0-9]+)'/)?.[1] ?? null,
      why: 'reported in telemetry, so a wrong value makes traces un-attributable to a release',
    },
    {
      file: 'CHANGELOG.md',
      extract: (s) => s.match(/^##\s*\[([0-9]+\.[0-9]+\.[0-9]+)\]/m)?.[1] ?? null,
      why: 'the released heading; `[Unreleased]` means the release notes were never cut',
    },
  ]

  const found = LOCATIONS.map((l) => ({ ...l, value: l.extract(read(l.file)) }))

  test('every location yields a version (extraction is not silently empty)', () => {
    // Negative control on the extraction itself. Without this, a broken regex returns null for
    // every file and the agreement check below would pass on an empty set.
    const missing = found.filter((f) => !f.value).map((f) => f.file)
    expect(missing, `no version could be extracted from: ${missing.join(', ')}`).toEqual([])
    expect(found.length).toBeGreaterThanOrEqual(7)
  })

  test('all stamped locations agree', () => {
    const versions = [...new Set(found.map((f) => f.value))]
    expect(
      versions.length,
      `version stamped inconsistently:\n` +
        found.map((f) => `  ${f.value}  ${f.file}  (${f.why})`).join('\n'),
    ).toBe(1)
  })

  test('the git tag, when present, matches the stamped version', () => {
    // GITHUB_REF is `refs/tags/v1.0.0` on a tag push and `refs/heads/main` otherwise, so this
    // assertion is a no-op locally and on branch pushes — deliberately, rather than fake-passing.
    // It still catches the case that matters: tagging a release without bumping the version, which
    // would publish `:1.1.0` images reporting `1.0.0`.
    const ref = process.env.GITHUB_REF ?? ''
    if (!ref.startsWith('refs/tags/v')) return
    const tag = ref.slice('refs/tags/v'.length)
    // `value` is string|null because an extraction can fail; the test above proves it did not, but
    // asserting that here keeps this test independent of test ordering.
    const stamped = found[0].value
    expect(stamped).not.toBeNull()
    expect(tag, `tag v${tag} does not match the stamped version ${stamped}`).toBe(stamped as string)
  })

  test('no location is still at a pre-1.0 or placeholder value', () => {
    // Guards the specific historical failure: four numbers in eight places. A placeholder that
    // survives into a release is the same defect as a stale one.
    const bad = found.filter((f) => /^(0\.0\.0|0\.4\.0|0\.5\.0|2\.0\.0|1\.0\.0-beta|change-me)$/.test(String(f.value)))
    expect(bad.map((f) => `${f.file}=${f.value}`), 'placeholder or stale version stamped').toEqual([])
  })
})
