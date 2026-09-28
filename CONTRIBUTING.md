# Contributing

## Development Setup

```bash
bun install
bunx prisma db push
bunx prisma generate
bun run dev
```

## Before Submitting

All of the following must pass before opening a PR:

- `bunx tsc --noEmit` — 0 errors
- `bun run lint` — 0 errors
- `bun run test` — all tests pass
- `bun run e2e` — run if your change touches UI

## Code Style

- TypeScript strict mode; no `any` without justification.
- English in all strings, comments, and docs.
- Server-only libraries live in `src/lib/` and must never be imported into client components.
- Comments explain **why**, not **what**.
- No new dependencies without discussion.

## Branches — exactly two live, permanently

| branch | role | what may be pushed to it |
|---|---|---|
| `main` | **released**. Every commit here is a version customers can install. | only merged release PRs, and the `v*.*.*` tag that names the release |
| `dev` | **integration**. Work lands here first, CI runs, then it is promoted to `main` when a release is cut. | feature, fix and docs commits, directly or via a short-lived PR |

Everything else is **temporary and deleted after merge**. MEASURED REASON this rule exists: this repo
accumulated **18 local and 28 remote branches** — 14 of them from one session's PRs alone — so the branch
list stopped describing the project and started being an archive of finished work. Branch names are not
storage: once a PR is merged, `main` holds the commit and the branch name holds nothing.

The one exception is a bot's branch: `dependabot/**` is owned by Dependabot and is deleted when its PR
closes or merges. Do not delete one by hand while its PR is open.

```bash
# after a merge, delete the branch — both copies
git branch -d <branch>              # local, -d refuses an unmerged branch on purpose
git push origin --delete <branch>   # remote
```

**Verify a branch is merged before deleting it**, and check CONTENT rather than the commit graph: this
project squash-merges, so `git merge-base --is-ancestor <branch> main` reports a merged PR as "not merged"
because the original commits never entered `main`. `git diff main..<branch> --stat` showing only DELETIONS is
the signal that `main` is strictly ahead.

## Release tagging — every release gets a tag

A moving image tag is a pointer, not a release: `:app` silently advances to whatever `main` last produced, so
"the version I tested" and "the version the customer runs" become different artifacts under one name, with
nothing to roll back TO. **Tag every release**, so a customer can pin and a rollback has a target.

| change | version | example |
|---|---|---|
| `fix:` only | **patch** | `1.0.0` → `1.0.1` |
| any `feat:`, no breaking change | **minor** | `1.0.0` → `1.1.0` |
| a breaking change (a customer must act) | **major** | `1.0.0` → `2.0.0` |

```bash
# 1. bump the version in ALL eight stamped locations (the guard lists them and fails if one lags)
bun test src/lib/release-version.test.ts
# 2. cut the CHANGELOG heading from [Unreleased] to the version and date
# 3. land it on main, then tag the commit main is AT
git tag -a v1.1.0 -m "Release 1.1.0" && git push origin v1.1.0
```

`docs/RELEASE.md` is the full checklist, including the steps no local test can do (the registry checks that
once shipped an install nobody could complete). `src/lib/release-version.test.ts` enforces that the tag, the
`version` field and the other stamped locations all agree — a tag that disagrees with the artifact produces an
image whose name says one version and whose UI displays another.

## Pull Request Process

- Squash merge is the default.
- Use Conventional Commits: `feat:`, `fix:`, `docs:`, `refactor:`.
- One logical change per PR.
- Include tests for new logic.
- **Delete the branch after merge.** See "Branches" above.
