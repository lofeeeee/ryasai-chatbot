# ADR 0011: Dependency Security as a CI Invariant

**Status:** Accepted  
**Date:** 2026-10-02

## Context

Before 2026-10, `bun audit` reported **130 advisories, of which 2 critical**. Both criticals were
unauthenticated remote-code-execution flaws in Next.js, fixed only in >=16.3.3. One was specific to
Windows-hosted servers; the other, in the Image Optimization API, is reachable in this application
*before anyone signs in*, because the login screen renders an image through `next/image` and the
optimizer answers anonymous requests.

The instructive part was not the count but the shape of the regression. `package.json` declared
`^16.1.1`, a range that *allows* a version below the fix — so a routine `bun add`, or a fresh
install on a new machine, would have quietly reinstalled the vulnerable version even after every
existing machine happened to be patched. A one-time cleanup fixes the machines; it does nothing
about the range that reintroduces the flaw tomorrow.

Two further classes showed the same pattern:

- `prismjs` is pulled transitively by `react-syntax-highlighter` → `refractor@3.6.0` →
  `prismjs@~1.27.0`, and that copy is bundled into a **client chunk** — the DOM-clobbering
  advisory ships to the browser, not just to a build tool.
- `deepmerge-ts` and `effect` are pinned exactly by `@prisma/config@6.19.2`, so no ordinary update
  could move them. They were first carried as accepted risk because they live in the prisma CLI
  rather than the app image, and were then fixed by override after the real `prisma db push`
  command was measured unchanged inside the real scheduler image, and the replacement merge library
  was verified to produce identical output on every merge shape a config file exercises.

Dependency security had been handled as periodic cleanup: someone remembers to run the audit,
someone remembers to run it again after the next change. Every gap in that memory is a window in
which a known unauthenticated RCE ships — and `bun audit` is a command an operator has to
*remember*, which is exactly the property that makes it unsuitable as the only control.

## Decision

Dependency security is asserted as a CI invariant (`src/lib/dependency-security.test.ts`) rather
than left to scheduled cleanups. The test runs on every push, reads the repo's own lockfile and
`node_modules`, and needs no network:

1. **The Next.js floor is a test, not just a manifest entry.** It asserts the *declared range*
   cannot resolve below the RCE fix (>=16.3.3) and that the *installed* version is at or above it.
   The range is checked because the range is what a fresh install consults — asserting only the
   installed copy is precisely how `^16.1.1` survived while machines happened to be patched.

2. **The `prismjs` override (1.30.0) is asserted at three layers:** the override exists in
   `package.json`; the lockfile resolves *every* copy at or above the fix (a nested `refractor`
   keeping its own vulnerable copy beside a clean top-level one is the failure mode); and the
   installed copy matches, so a stale `node_modules` cannot pass for a fix.

3. **The absence of accepted-risk packages from the shipped image is asserted rather than assumed**
   — and the guard reports itself *skipped*, not passed, when there is no build on disk to inspect.
   Its first version asserted that a file was absent, which passes vacuously on a clean checkout:
   exactly where CI runs it.

4. **`bun audit` must report zero.** Audit remains the authority on what is vulnerable; the test is
   what keeps a regression from waiting for the next time someone remembers to run it.

One property of the test is deliberate and worth naming: it asserts *resolutions*, not intentions.
An override that exists in `package.json` but is overridden again by a transitive exact pin, or a
lockfile entry that is clean while a second copy sits nested inside another package, both fail. The
installed tree is what runs, so the installed tree is what gets checked.

## Consequences

- **Positive:** an advisory cannot re-enter through a version range, a nested lockfile resolution,
  or a stale `node_modules` without a red build. The three routes are closed separately because
  they are separate routes.
- **Positive:** each pin records *why* it exists in the same file, so the next reader can tell a
  live constraint from an obsolete one and re-measure rather than cargo-cult.
- **Positive:** the test needs no network and no build, so it runs in the same CI job as typecheck —
  it cannot be skipped because the environment that would have run it was not provisioned.
- **Negative:** an override of a package pinned exactly by its parent is a commitment, not a free
  fix — it must be re-measured whenever the parent is upgraded. The prisma-CLI overrides were
  accepted as risk first and only overridden after `prisma db push` and `prisma validate` were
  verified unchanged.
- **Negative:** the invariant only covers what it enumerates. A new advisory in an unlisted package
  surfaces through `bun audit`, which is why audit stays the authority and the test is a floor, not
  a ceiling.
- **Negative:** the "no accepted-risk package in the shipped image" check cannot run without a
  build on disk. It reports itself skipped there rather than passing, so a CI job that forgot to
  build shows up as an unverified check instead of a green one.

## Alternatives

- **Periodic audit + cleanup:** rejected — `^16.1.1` demonstrated that cleanup does not constrain
  what the *next* install resolves.
- **Automated dependency-update PRs as the primary control:** rejected — they still need someone to
  merge them, and a critical with an unauthenticated RCE cannot wait on queue latency.
- **Accepting the CLI-only advisories permanently:** rejected after measurement — a tool that runs
  on every customer boot at install time is not a place to leave a known high-severity flaw, and
  the fix was verified to change nothing about its behaviour.
- **Locking `next` to an exact version rather than a floor:** rejected — a caret floor still
  receives patch updates, while an exact pin turns every upstream patch release into a manual edit
  that would train maintainers to bump it without reading.
