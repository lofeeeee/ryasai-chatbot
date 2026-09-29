# Build and deploy reference

Moved out of `AGENTS.md` on 2026-09-29 as part of bringing the instruction budget back under 65,536 bytes: with
`CLAUDE.md` read first, `AGENTS.md` was being TRUNCATED, and the truncated tail included rules that matter (see the
note in `AGENTS.md`'s Architecture pointer).

Read this when building an image, publishing a release, or debugging a deploy. It covers how the DISPLAYED version
actually reaches a customer (the obvious path is dead — the Dockerfile declares no ARG, so the hardcoded fallback in
`public-config.ts` is the real mechanism), the known `middleware` deprecation warning that is not a defect, and the
compose-first deployment shape.


**HOW THE DISPLAYED VERSION REACHES THE IMAGE — checked, because the obvious path is dead.**
`src/lib/public-config.ts` exposes `appVersion` from `NEXT_PUBLIC_APP_VERSION`, and `install.sh`
writes that variable into the customer's `.env`. That `.env` line does **not** set it for the
browser: `NEXT_PUBLIC_*` is normally substituted by the bundler at BUILD time, and the Dockerfile
declares no `ARG`/`ENV` for it, so no substitution happens. Inspected in the built output:

    server chunk : appVersion: process.env.NEXT_PUBLIC_APP_VERSION ?? "1.0.0"
    client chunk : M.default.env.NEXT_PUBLIC_APP_VERSION || "1.0.0"

so what a customer actually sees is the **hardcoded fallback**. That is why the fallback is kept
equal to the released version (1.0.0) and is called out above as needing to move with any future
release — it is the real display value, not a placeholder. If a deployment ever needs to override
the version at build time, add `ARG NEXT_PUBLIC_APP_VERSION` to the builder stage and pass it from
compose `build.args`; until then the fallback IS the mechanism.

**KNOWN FORWARD-COMPAT WARNING, not a defect.** `bun run build` prints:

    ⚠ The "middleware" file convention is deprecated. Please use "proxy" instead.

`src/middleware.ts` is still supported and still runs (it carries the rate limiting and has its
own test file), so this is a migration to schedule rather than a bug to fix — but it is recorded
here because it appears on every build and an unexplained warning trains people to ignore build
output. Migrating means renaming the file and re-checking the `matcher` config against Next's
current `proxy.ts` semantics; do it deliberately, not as a drive-by during unrelated work.

- **Build runs under real Node** (`node:22-slim`), not Bun — Turbopack breaks under Bun's node-compat shim (jsdom `patch.json` error). Prod runtime is Bun (`oven/bun:1-slim`).
- `bun run build` produces `.next/standalone/`. The script also copies `.next/static` and `public/` into it.
- Docker images: `Dockerfile` (app) + `Dockerfile.scheduler` (scheduler). CI (`build-images.yml`) builds and pushes to GHCR on `main` push and version tags. `ci.yml` runs lint + typecheck + unit tests on every push/PR, plus the e2e suite against a pgvector service container.
- Deployment is compose-first: `docker-compose.yml` pulls prebuilt GHCR images and runs a `migrate` one-shot (scheduler image ships the Prisma CLI) before `app`/`scheduler`; plus Redis and `pgvector/pgvector:pg16`. `install.sh` is the one-liner installer (`--with-searxng` adds a private SearXNG for the web_search tool). A `helm/` chart also exists but lags the compose path.
- `next.config.ts`: `output: "standalone"`, `serverExternalPackages` for cognee/ioredis/bullmq/DB drivers/OTel SDKs, `outputFileTracingIncludes` pinning the DB driver packages into the standalone output (both are guarded — see invariants #3).
