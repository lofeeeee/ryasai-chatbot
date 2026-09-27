# Release checklist

Run this before telling a customer to install. Every step is here because a product was once shipped
with it missing or unverified.

> **Why this file exists.** `src/lib/release-images.test.ts` can only prove the STATIC half of a
> release — that every image tag `install.sh` references is also a build target in
> `build-images.yml`. It cannot reach the registry, so it cannot prove the tag is actually
> *published*. On 2026-09-25 that gap shipped a product nobody could install: the `:embeddings`
> build step existed and the tag did not, so `docker compose pull` returned
> `...:embeddings: not found` and `install.sh` aborted. The static gates were all green.
> **The steps marked (registry) below are the ones no local test can do for you.**

---

## 1. Local gates

```bash
bunx tsc --noEmit          # 0 errors
bun run lint               # 0 errors
bun run test               # read the count it prints; 0 fail
bun test benchmark/        # golden set
bun test src/lib/invariants.test.ts
bun run build              # must produce .next/standalone/server.js
```

Both e2e modes are mandatory — they diverge in ways that are invisible in dev:

```bash
bun run e2e                # next dev
bun run e2e:prod           # .next/standalone/server.js with NODE_ENV=production
```

If a run fails after you interrupted a previous one, clear the document queue first: orphaned BullMQ
jobs make an uploaded document embed only partly, and the citation assertion then fails in a way that
looks like a retrieval bug.

```bash
redis-cli --scan --pattern 'bull:document-processing:*' | xargs -r redis-cli del
```

## 2. Version consistency

`NEXT_PUBLIC_APP_VERSION` is NOT substituted by the bundler — the Dockerfile declares no `ARG` — so
the **code fallback is what the customer's UI displays**. Keep the fallback equal to the release:

```bash
grep -oE '"version": *"[^"]+"' package.json
grep -E '^(APP_VERSION|NEXT_PUBLIC_APP_VERSION)=' .env.example
grep -oE 'APP_VERSION=[0-9.]+' install.sh
# The appVersion ASSIGNMENT, not just any version-like string: this file's own comment quotes the
# historical drifted values (0.4.0, 2.0.0, 0.5.0) to explain why they were unified, so a loose grep
# matches the prose and reports a mismatch that does not exist. A naive `grep -oE '[0-9]+\.[0-9]+\.'
# reported 0.4.0 here while the real value is 1.0.0.
grep -E "appVersion:.*'[0-9]+\.[0-9]+\.[0-9]+'" src/lib/public-config.ts
```

All four must agree. `CHANGELOG.md` must have a released heading, not `[Unreleased]`.

The same trap applies to the image check in step 3: `grep … ghcr.io/…:embeddings build-images.yml`
matches this file's own explanatory comments as well as the build step. Match the `tags:` line, or
strip comments — which is what `src/lib/release-images.test.ts` had to do after its negative control
passed vacuously.

## 3. Published artifacts — **(registry)**

**This is the step that shipped broken.** A tag being *referenced* is not the tag being *reachable*.

```bash
# Every image the generated compose pulls must resolve.
docker compose -f /tmp/ryasai-compose.prod.yml pull
echo "exit=$?"   # MUST be 0
```

To check a single tag directly:

```bash
docker manifest inspect ghcr.io/ryasrk/ryasai-chatbot:app        >/dev/null && echo app:OK
docker manifest inspect ghcr.io/ryasrk/ryasai-chatbot:scheduler  >/dev/null && echo scheduler:OK
docker manifest inspect ghcr.io/ryasrk/ryasai-chatbot:embeddings >/dev/null && echo embeddings:OK
```

If any is missing, publish it — all three are built by `.github/workflows/build-images.yml`, which
runs on a `main` push, a `v*.*.*` tag, **or** manually:

```bash
gh workflow run build-images.yml        # no code change needed
gh run watch                            # confirm all THREE build steps ran
```

Confirm the step list, not just the exit code: a run can succeed while a step is absent, which is
exactly what happened (steps 5, 6, then 8 — step 7 did not exist yet).

Tags NOT ours and therefore not built by us, but still required:
`cognee/cognee:1.6.0`, `pgvector/pgvector:pg16`, `redis:7-alpine`, `searxng/searxng:latest`.

## 3b. Version tags — publish a pinnable, rollback-able release

The moving tags (`:app`, `:scheduler`, `:embeddings`) are what `install.sh` pulls. They are pointers,
not releases: a `docker compose pull` on an existing install silently advances to whatever `main`
last produced, so "the version I tested" and "the version I am running" are different artifacts
wearing one name — and overwriting a moving tag destroys the previous one, so there is nothing to
roll back TO.

Pushing a `v*.*.*` tag fixes both. `build-images.yml` appends the version to each image:

| Ref pushed | Tags published |
|---|---|
| `main` | `:app`, `:scheduler`, `:embeddings` |
| `v1.0.0` | the three above **plus** `:1.0.0`, `:1.0.0-scheduler`, `:1.0.0-embeddings` |

```bash
git tag -a v1.0.0 -m "Release 1.0.0"
git push origin v1.0.0
```

Then confirm the versioned tags exist — the workflow now does this itself in a
"Verify published images resolve" step that fails the release if any of the three is absent, because
a release publishing only SOME of its images is the exact defect that blocked installs.

EXECUTED for v1.0.0 on 2026-09-26. `Build Images` succeeded and the registry then listed six tags —
the three moving ones plus all three versioned:

    1.0.0   1.0.0-scheduler   1.0.0-embeddings   app   scheduler   embeddings

`docker manifest inspect` resolved all three versioned tags. `:1.0.0` and `:app` share digest
`sha256:759dfcbe…` and `:1.0.0-scheduler` matches `:scheduler` (`sha256:0366af57…`), so the pinned name
is the same artifact the moving tag points at. `:1.0.0-embeddings` has its OWN digest
(`sha256:380e21ac…` vs `:embeddings` `sha256:cfa19df5…`) because it is a separate build target from a
different context — expected, and the reason each image is verified individually rather than assuming
three pushes agreed.

The pinned image was then pulled and RUN, not merely resolved:
`ghcr.io/ryasrk/ryasai-chatbot:1.0.0-embeddings` pulled and started, loaded
`sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2` in 89.9 s, answered `GET /health` with
200, and returned a **384-dimension** embedding — the dimension the app expects.

One rehearsal note: the service listens on **8081**, not 80. A healthcheck aimed at 80 reports
`connection refused` for a perfectly healthy container, and because the model takes ~90 s to load the
first probe also races startup. Both look like a broken image and are not.

```bash
for t in 1.0.0 1.0.0-scheduler 1.0.0-embeddings; do
  docker manifest inspect ghcr.io/ryasrk/ryasai-chatbot:$t >/dev/null && echo "$t OK"
done
```

**A release tag must match `package.json`.** `src/lib/release-version.test.ts` enforces that the tag
you push, the `version` field, and the four other places the version is stamped all agree — see step 2.
A tag that disagrees with the artifact produces an image whose name says one version and whose UI
displays another.

**To pin a customer to a release**, edit the generated `/opt/ryasai-chatbot/docker-compose.prod.yml`
tags from `:app` → `:1.0.0` (and the matching `-scheduler` / `-embeddings` forms), then
`docker compose pull && docker compose up -d`. That is the rollback path too: point the tags at the
previous version and re-pull.

## 4. External services — **(network)**

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://license.ryasai.my.id/health          # 200
# A fabricated key must be REJECTED, not accepted:
curl -s -X POST https://license.ryasai.my.id/api/v1/license/validate \
  -H 'Content-Type: application/json' \
  -d '{"license_key":"TOTALLY-FAKE","machine_id":"m","product":"ryasai-chatbot"}'
# expect: {"valid":false,...} with a signature
```

A validator that accepts a fake key is worse than one that is down.

## 5. Fresh-install rehearsal — **(the only test that proves the product is sellable)**

On a clean host, or a clean Docker context:

```bash
curl -sSL https://ryasai.my.id/install.sh | bash
```

Then confirm, in order: the health wait passes, the signup flow creates an org, a document upload
reaches `embeddedChunkCount === chunkCount`, and a question about that document returns an answer
with a citation. Steps 1–4 verify components; this verifies the product.

EXECUTED ON 2026-09-26, in a faithful rehearsal rather than by reasoning: the compose file the
installer writes, the patch scripts it writes beside it, and the published images. Result — all seven
services healthy and the app answering from the host:

    app: Up (healthy)              cognee: Up (healthy)
    db: Up (healthy)               local-embeddings: Up (healthy)
    redis: Up (healthy)            scheduler: Up
    searxng: Up
    GET /api/v1/health   -> {"ok":true,"service":"ryasai","version":"1.0.0",...}
    GET /api/health      -> 200   (real dependency check, DB reachable)
    GET /                -> 200   <title>ryasai</title>

Two things to know when running it yourself:
- `GET /login` is a 404 BY DESIGN. The app is a single client-side page at `/`; there is no separate
  login route, and expecting one reads as a broken install when it is not.
- The cognee service mounts `./cognee-patch`, which the INSTALLER writes (it is not in the repo).
  Running the compose file alone gives `entrypoint-with-patch.sh: No such file or directory` and a
  restart loop. That is a rehearsal mistake, not an install defect — but it looks exactly like one.

A port can also be published yet unreachable after repeated container start/stop cycles
(`HostConfig.PortBindings` present, `.NetworkSettings.Networks` empty). `docker compose up -d
--force-recreate <service>` cleared it. Worth knowing so a networking artifact is not mistaken for a
product failure, which is what happened here first.

## 5b. Shipping an update to an existing install

Same command as a fresh install — the installer detects `/opt/ryasai-chatbot/.env` and takes the
update path:

```bash
curl -sSL https://ryasai.my.id/install.sh | bash          # upgrade to latest
git tag -a v1.0.1 -m "Release 1.0.1" && git push origin v1.0.1   # then publish, per step 3b
```

What the update path does, in order:

1. **Keeps the existing port** from `.env` unless `--port` was passed.
2. **Backs up the database** with `pg_dump` into `backups/`, keeping the newest 5.
3. **Reports environment drift** against `.install-manifest` (written by the previous run, below) and
   names any setting the new version expects that this install does not set. It **changes nothing** —
   `.env` holds the license key, secrets and port, so regenerating it would destroy the install.
4. **Regenerates the compose file** from the current installer, then pulls. A failed pull **leaves the
   running containers untouched** and exits non-zero, so an unreachable registry does not take a
   working deployment down.
5. **Migrates** via the `migrate` one-shot, gated on `db`/`redis` health and on
   `service_completed_successfully`, then starts `app`/`scheduler`.

`.env` is NEVER rewritten on update. The consequence is that a variable added by a newer release
never reaches an existing install unless an operator sets it — which is why step 3 exists. The
installer records `.install-manifest` (version + generated variable names, **names only, never
values**) so the next update can diff against it. An install predating the manifest is told
"cannot report env drift" rather than being falsely reported as clean.

Verify after an update, on the customer host:

```bash
grep '^NEXT_PUBLIC_APP_VERSION=' /opt/ryasai-chatbot/.env    # expect the new version
grep -E '^version=' /opt/ryasai-chatbot/.install-manifest    # what the installer last wrote
curl -s http://127.0.0.1:38180/api/v1/health                 # {"ok":true,"version":"..."}
ls -1t /opt/ryasai-chatbot/backups/ | head -3                # a fresh dump exists
```

**Rollback**: point the compose tags at the previous version (step 3b), `docker compose pull && docker
compose up -d`, then restore the dump if the schema moved:

```bash
docker compose -f /opt/ryasai-chatbot/docker-compose.prod.yml exec -T db \
  psql -U ryasai -d ryasai < /opt/ryasai-chatbot/backups/ryasai-<stamp>.sql
```

## 5c. Field report: the 1.0.0 update of a live 0.5.0 deployment

Executed 2026-09-27 against the production install. Four defects surfaced that no local test could
have found, which is the argument for running this on real hardware before a customer does.

| # | defect | how it presented | fix |
|---|--------|------------------|-----|
| 1 | `install.sh` set `LICENSE_KEY_CONFIGURED` only when `--license-signing-public-key` was PASSED | a working install printed "LICENSING NOT OPERATIONAL — ACTION REQUIRED" | read the value from `.env` first |
| 2 | `ENC_KEY: unbound variable` | EVERY update aborted (`set -u` + a template referencing an unset var) | `${VAR:-}` in `render_env` |
| 3 | `APP_DIR` hardcoded to `/opt/ryasai-chatbot` | created a SECOND deployment beside the real one at `/home/ubuntu/ryasai-chatbot`, regenerating `ENCRYPTION_SECRET_KEY` | `--dir` flag + refuse-to-create-a-second-stack guard |
| 4 | `DocumentChunk.tsv` was created by raw SQL but not declared in the Prisma schema | `prisma db push` tried to DROP a column holding data; migrate exited 1 and the app never started | declare `tsv Unsupported("tsvector")` |

DEFECT 3 IS THE DANGEROUS ONE and is worth stating plainly. Both keys were valid hex, and only one
decrypts the stored configs. Attempting decryption of a real `LlmConfig.encryptedApiKey`:

    /opt key  -> GAGAL (Unsupported state or unable to authenticate data)
    /home key -> OK (apiKey recovered)

so the wrong directory is not a misconfiguration, it is silent data loss: the app starts, then cannot
read the customer's own provider credentials. The guard now REFUSES to run and names the right
`--dir`.

DEFECT 4 WAS CAUGHT BY A FAIL-CLOSED STOP, not by review: `db push` refuses to drop a column holding
data. Without that check the push would have succeeded, dropped `tsv`, and disabled BM25 ranking for
every later search on a running system with no error anywhere. Verified non-destructively against
real data restored into a scratch database: old schema aborts; fixed schema reports in-sync and all 4
`tsv` values survive.

### After the update — what to check on the customer host

```bash
docker compose -f /opt/ryasai-chatbot/docker-compose.prod.yml ps   # all healthy
curl -s http://127.0.0.1:38180/api/v1/health                       # version matches the release
```

**`NEXT_PUBLIC_APP_VERSION` in an existing `.env` is STALE after an update**, by design: `.env` is
never rewritten (it holds the license key, secrets and port), so a deployment created at 0.5.0 keeps
reporting 0.5.0 even while running 1.0.0 images. Update that one line by hand — it is the value the
UI displays:

```bash
sudo sed -i 's|^NEXT_PUBLIC_APP_VERSION=.*|NEXT_PUBLIC_APP_VERSION=1.0.0|' /opt/ryasai-chatbot/.env
sudo docker compose -f /opt/ryasai-chatbot/docker-compose.prod.yml up -d app
```

### Cognee: the 1.6.0 image breaks memory, and the installer now repairs it

Two independent faults, both found by attempting a real write rather than trusting `/health`:

1. **The extension tree moved and was FLATTENED.**

       1.5.4 (works): /app/.lbdb/extension/0.19.0/linux_amd64/json/libjson.lbug_extension
       1.6.0 (broken): /app/cognee_db_workers/ladybug_extensions/v0.19.0/linux_amd64/libjson.lbug_extension

   The server reads the first form, including the `<ext>` level. In 1.6.0 the old tree does not exist
   at all, so `/health` returns 503 permanently and every `POST /api/v1/remember` fails with
   "Failed to load library ... libjson.lbug_extension". The generated entrypoint restores it, deriving
   `<ext>` from the filename and discovering the version directory rather than pinning either.

2. **`COGNEE_LLM_API_KEY` is empty on the deployment inspected**, so cognee cannot run its own
   extraction pipeline and a write fails even with the extension restored. This is an OPERATOR
   decision (which key), not something the installer should guess, so it is reported rather than
   filled in. Cognee reuses nothing automatically: it needs `COGNEE_LLM_*` in `.env`.

After the update, confirm health AND a write — health alone does not prove memory works:

```bash
docker exec <cognee> curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8000/health   # 200
```

### Cognee config lives in `.env.cognee`, NOT `.env`

The installer writes a separate file for the memory sidecar and pre-fills everything that
needs no customer input:

```ini
# /opt/ryasai-chatbot/.env.cognee  (mode 600)
LLM_PROVIDER=openai
LLM_ENDPOINT=            # <- set these three to enable memory
LLM_MODEL=               #    model needs the `openai/` prefix
LLM_API_KEY=
EMBEDDING_ENDPOINT=http://local-embeddings:8081/v1     # pre-filled, works as-is
EMBEDDING_MODEL=sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2
EMBEDDING_DIMENSIONS=384
LLM_ALLOWED_HOSTS=*
AUTO_FEEDBACK=false
IMPROVE_AUTO_ENABLED=false
```

Apply a change with `docker compose -f .../docker-compose.prod.yml up -d cognee`. **Never** put these
in `.env`: a compose `environment:` entry for the same key OVERRIDES this file, and because the old
entries were written `${VAR:-}`, an unset variable resolved to EMPTY and blanked the file. That is
why a separate config could previously be set and appear to do nothing.

**`COGNEE_LLM_*` / `COGNEE_EMBEDDING_*` in `.env` are DEAD.** They were the old mechanism. An update
copies their values into `.env.cognee` (only where the destination is empty — a configured value is
never overwritten) and leaves the old lines in place, unread, because rewriting `.env` during an
update is how the earlier incident happened. Edit `.env.cognee` from now on.

**Memory needs its own LLM key.** It cannot reuse the app's: that config lives encrypted in the
database and is unreachable from the sidecar. With `LLM_API_KEY` empty the container reports
`{"status":"ready","health":"healthy"}` and every *write* still fails — health is not proof that
memory works. Confirm with a real write, not with the health check.

### The UI shows per-component diagnosis, not just a badge

Knowledge → "Cognee Memory & Knowledge Graph" now renders a Diagnostics panel sourced from the
sidecar's `/health/detailed`. It exists because a single status cannot be acted on: measured on this
install, the sidecar answered `{"status":"ready","health":"healthy"}` while every memory write FAILED.

What an operator sees on a half-broken sidecar:

```
Diagnostics  [degraded]  How to fix
2 of 6 dependencies need attention — and the extraction LLM is one of them,
so memory writes will FAIL even though the container is up.
  Relational store   sqlite   22ms
  Vector store       lancedb   0ms
  Knowledge graph    kuzu      7ms
  File storage       local     2ms
  Extraction LLM     unknown  17ms      <- click for the server's own error text
  Embedding service  unknown  30002ms   <- "Likely a false alarm — click for details."
```

Two behaviours worth knowing before reading the panel:

- **`/health/detailed` returns HTTP 503 with a complete JSON body.** That is the server's verdict, not
  a transport failure. The client parses 503 deliberately; a 500 or an HTML error page still yields
  "no diagnosis" rather than a partial one.
- **`embedding_service` cries wolf.** Its probe uses a 30s budget and reports `degraded` while the
  same container returns valid 384-dimension embeddings. The panel says so inline, so it is not
  mistaken for a real fault. If documents embed normally, ignore it.

The header badge reads **"Cannot store"** instead of "Connected" when the diagnosis names a broken
extraction LLM: reachability and usability are different claims, and only the second one matters.

## 6. What is deliberately NOT covered

- **Answer quality is not gated in CI.** `rag-eval` / `sql-eval` run via the manual `eval.yml`
  workflow. Numbers live in `docs/hasil-pengukuran.md`; re-measure rather than trusting a figure
  quoted in a document.
- **Retrieval quality** is measured by `benchmark/real-prose-arm.ts` against a real embedder, not by
  the e2e suite — the e2e mock embedder is a hashed bag of tokens and cannot rank honestly at the
  corpus sizes involved.
- **Migrations for existing installs** (e.g. a `vector(1536)` → `vector(384)` change) are documented
  in `prisma/schema.prisma` and `tools/local-embeddings/README.md`, not automated.
