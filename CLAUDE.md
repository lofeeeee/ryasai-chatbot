# CLAUDE.md — ryasai Chatbot (Super-App Track)

> Living document. Update the **Progress Log** at the bottom every session.
> Last updated 2026-10-01. Version 1.7.6. PostgreSQL 16. All PLAN.md phases P0–P5 + S4 + RAG complete. Language standardized to English.
>
> **Counts and versions in this file drift.** Section 1 and 8 describe CURRENT state — run the
> command rather than trusting a number written here; section 9 (Progress Log) is HISTORICAL and
> its numbers were true when written — do not "fix" them. When you need a number, run the command. (Section 2 was three
> releases stale — it claimed 6825 tests across 265 files when this tree measures 7206 across 289 —
> which is why it moved to docs/ rather than being re-corrected in place.)

---

## 1. Project Identity

| | |
|---|---|
| Path | `/home/ryasr/ryasai/Chatbot` |
| Stack | Next.js 16 (App Router) · React 19 · TypeScript 5 · Prisma 6 · PostgreSQL 16 (pgvector + pg_trgm) · Bun · Tailwind 4 · shadcn/ui |
| Runtime | Bun for dev/test, Node standalone for prod build |
| Domain | Multi-tenant AI assistant deployed **on-prem per customer**, licensed with a signed machine-bound key: natural-language → SQL, RAG over company docs, whitelisted REST calls, streaming chat |
| Status | **Release 1.7.6** (2026-10-01). Latency + security. Verified by execution, not assertion: `tsc` 0 · `lint` 0 · `bun run test` 313/313 files, 7672 pass, 0 fail · coverage:gate exit 0 · `e2e` and `e2e:prod` both 19 passed |
| Version | 1.7.6 |
| Language | English (standardized — all UI, errors, system prompts, comments in English) |

---

## 2. Audit Summary (moved)

The component-by-component inventory — auth and tenancy, the data layer, the AI pipeline, guardrails, connectors,
observability, the intent pipeline, the agentic loop and the scheduler — now lives in
**`docs/architecture-reference.md`**, beside the AI/RAG internals it overlaps with.

It is there rather than here for a MEASURED reason: `CLAUDE.md` plus `AGENTS.md` came to 97 KB against a 65,536-byte
instruction budget, so the tail of `AGENTS.md` was silently truncated. Both files describe the same system, so the
inventory belongs with the architecture rather than in a history log.

**Counts there are historical.** Verify with `grep -c` against the code — this section spent months claiming
"913 tests across 56 files" long after both numbers had changed.

## 3. Super-App Vision

A **super-app** = one tenant-facing app that hosts many capabilities (tools), orchestrates them agenticly, remembers everything, and lets third parties extend it. WeGo, Grab, and ChatGPT-with-plugins are the reference shapes.

### Target state

```
User query
   │
   ▼
┌─────────────────────────────────────────────────────┐
│  Orchestrator (Planner LLM)                         │
│  intent → multi-step plan [tool₁, tool₂, tool₃]     │
│  with data deps:  tool₂.input = tool₁.output        │
└─────────────────────────────────────────────────────┘
   │
   ▼
┌─────────────────────────────────────────────────────┐
│  Tool Registry (plugin-based)                       │
│  sql · rag · rest · web-search · code-interpreter   │
│  · email · calendar · custom-tenant-tools …         │
└─────────────────────────────────────────────────────┘
   │ per-step: execute → observe → feed back
   ▼
┌─────────────────────────────────────────────────────┐
│  Memory Layer (cognee)                              │
│  session memory (fast) + knowledge graph (persistent)│
│  entities · relationships · past runs · preferences  │
└─────────────────────────────────────────────────────┘
   │
   ▼
┌─────────────────────────────────────────────────────┐
│  Synthesizer (Answer LLM)                           │
│  all tool outputs + memory context → NL answer       │
│  with citations + chart data + follow-up suggestions │
└─────────────────────────────────────────────────────┘
```

### Super-app principles (non-negotiable)

1. **Tenant isolation is sacred** — every tool, every memory query, every graph traversal is scoped by `organizationId` (injected by the tenant extension, not hand-written). No cross-tenant leakage ever.
2. **Fail-closed by default** — missing config, expired key, ambiguous permission → refuse, audit, explain. Never guess.
3. **Tools are whitelisted, never free-form** — the LLM proposes a tool *id* from a registry; it cannot invent endpoints or SQL tables.
4. **Every tool run is observable** — `ToolRun` row with latency, input/output summary, status. Every guardrail block → `AuditLog` critical.
5. **Memory is editable and forgettable** — GDPR/privacy: a tenant can delete their graph, a user can forget a fact. Cognee's `forget()` maps to this.
6. **Streaming end-to-end** — status updates per step, token streaming for synthesis. User never waits blind.
7. **Deterministic where it matters** — routing and SQL gen at temp=0. Creativity only in final synthesis.

---

## 4. Cognee Integration (the memory + graph layer)

### Why cognee

- **Open-source, self-hostable** (Apache-2.0) — no vendor lock-in, tenant data stays in your infra.
- **TypeScript client exists**: `@cognee/cognee-ts` — drops into Next.js without a Python sidecar.
- **One Postgres instance for memory** — cognee 1.0 keeps vectors + sessions + metadata in Postgres (its own `cognee_db`), beside the app's data. Replaces the JSON-embedding-in-SQLite hack (G8) and the flat-chunks problem (G3) in one move. The GRAPH is the exception and stays on embedded Kuzu — upstream labels its Postgres graph adapter a demo.
- **Four operations**: `remember`, `recall`, `forget`, `improve` — matches our mental model exactly.
- **BEAM benchmark SOTA** at 100K and 10M tokens — proven for long-context agent memory.
- **MCP server** available — future-proof for tool-using agents.

### Integration shape

**Phase 1 — Parallel memory (non-destructive)**
- Add `src/lib/cognee.ts` wrapping `@cognee/cognee-ts`.
- On every chat turn: `cognee.remember({ userMessage, aiMessage, toolRuns, sessionId })` against the org dataset. **The real names are `org:<id>` and `org:<id>:kb`** (`datasetFor()` / `kbDatasetFor()` in `cognee-types.ts`), not `company:{companyId}` — an earlier revision of this section used the old naming.
- On every `routeQuery`: first call `cognee.recall(question, { session_id })` → inject top memory hits into the router prompt as "prior context".
- Keep existing RAG untouched. Measure: does recall improve follow-up questions ("what about last month?")?

**Phase 2 — Knowledge graph for documents**
- Replace/augment `DocumentChunk` flat storage with cognee `cognify` pipeline:
  - Upload doc → extract text (reuse `document-parsers.ts`) → `cognee.add()` → `cognee.cognify()`.
  - Cognee extracts entities + relationships, builds graph, stores embeddings in pgvector.
- Retrieval: `cognee.recall(question)` returns graph-grounded chunks + related entities. Falls back to existing lexical RAG if cognee unavailable.
- Per-tenant dataset isolation: `org:<id>:kb` (see above).

**Phase 3 — Agent memory across sessions**
- `improve()` after each successful tool run: store "this SQL answered this question well" as a pattern.
- On future similar questions, `recall` surfaces the prior pattern → SQL gen prompt includes "last time this worked: …".
- This closes G2 (no learning) and G10 (no self-correction).

**Phase 4 — Graph reasoning for multi-hop**
- Questions like "who approved the invoice from the vendor that also supplied last quarter's anomaly?" → cognee graph traversal finds the path.
- Planner (§5) can emit a `graph_query` tool step that calls `cognee.recall` with a structured query.

### Cognee deployment

Both composes (`docker-compose.yml`, and the one `install.sh` generates) wire cognee identically —
there is no dev/prod store split any more:

- **Relational + vector + cache: the bundled PostgreSQL**, in cognee's OWN database `cognee_db`.
  Never the app's `ryasai` database: `migrate` runs `prisma db push` on every boot, which DROPS an
  unknown table it finds EMPTY (silently), and refuses to boot at all when that table has rows.
- **Graph: embedded Kuzu**, unchanged. Upstream labels its Postgres graph adapter a demo ("not
  production-ready"), so the `cogneedata` volume is still required.
- **`cognee-db-init`** (one-shot) creates `cognee_db` before cognee starts; cognee declares
  `depends_on: {cognee-db-init: {condition: service_completed_successfully}}`, because a missing
  database makes cognee exit(1) — under `restart: unless-stopped` that reads as a crash loop.
- **No `CACHE_DB_URL`.** With `CACHE_BACKEND=postgres` and the URL unset the cache reuses the
  relational database; a separate cache database aborts alembic `c3d5e7f9a1b2` and the sidecar
  never becomes healthy.
- Env names are cognee's, UNPREFIXED (`DB_*`, `VECTOR_DB_*`, `CACHE_BACKEND`, `GRAPH_DATABASE_*`);
  the `COGNEE_*` names belong to this app's `.env` and are not read by the sidecar. `LLM_*` /
  `EMBEDDING_*` deliberately live in `.env.cognee`, NOT in `environment:` (which always overrides).
- Guarded by `src/lib/cognee-store-wiring.test.ts`, which reads BOTH composes: every one of these
  reverts SILENTLY in production — cognee boots fine on the wrong store, it just writes where
  nobody looks.
- **Isolation**: cognee datasets are namespaced `org:<id>`. The wrapper in `cognee-types.ts` is the only place a dataset name is built, so no call can reach a name without an org. Verified against the code, not the design sketch.

### When NOT to use cognee

- < 50 documents and no multi-hop needs → existing RAG is simpler and faster. Cognee adds a Postgres dependency.
- Small deployment with no cross-session memory need → overkill.
- **Decision gate**: adopt cognee only when G2 (memory) OR G3 (multi-hop graph) becomes the blocker. Until then, the flat RAG is sufficient.

---

## 5. Algorithms (moved)

The routing, planning, hybrid-retrieval, guardrail, memory-write and agentic-loop sketches are in
**`docs/architecture-reference.md`**.

They describe the pipeline, so they sit with the pipeline. The sketches are DESIGN INTENT: where the shipped code
differs, the code wins — check the module before quoting a formula from here.

## 6. Best Practices (enforced)

### Security
- **Encrypt at rest**: all integration configs, LLM keys, vector store keys → AES-256-GCM (`src/lib/crypto.ts`). Never log decrypted values.
- **SQL guardrails**: every LLM-generated SQL passes `validateAndSanitizeLlmSql` before execution. No exceptions, no bypass flag.
- **REST whitelisting**: only `RestApiEndpoint` rows with `isEnabled=true` are callable. LLM cannot invent paths.
- **Tenant scoping**: the Prisma extension in `prisma-tenant.ts` injects `organizationId` from AsyncLocalStorage — it is NOT written into each `where` by hand, and there is no `companyId`. Two rules that ARE load-bearing: (a) every route must call `enterWithOrg(...)` itself (`enterWith` does not propagate to the caller's frame), enforced by `tenant-route-guard.test.ts`; (b) loading a row by a CLIENT-SUPPLIED id must use `findFirst`, never `findUnique`, because the extension cannot scope a unique `where`.
- **API keys**: hashed (`keyHash`), prefix-only stored, rate-limited, revocable, audit-logged.
- **Session cookies**: `httpOnly`, `sameSite=lax`, `secure` in prod, signed.

### Reliability
- **Fail-closed**: missing LLM key → 401/500 with message, never fallback to unbounded behavior.
- **Timeouts**: every external call uses `AbortSignal.timeout()` (60s LLM, 30s REST, 120s stream).
- **Idempotent writes**: `persistAiMessage` catches duplicate session errors gracefully.
- **Graceful degradation**: no integrations → CHAT; no documents → CHAT; vector store down → lexical fallback; embedding API down → lexical fallback.

### Performance
- **Schema reflection cache**: `IntegrationSchema` avoids re-reflection per query.
- **Candidate narrowing**: FTS/vector hits → load only those chunks, not all.
- **Per-document diversity cap**: `maxPerDocument=2` prevents one doc dominating.
- **Streaming**: status updates per phase, tokens for synthesis. User sees progress.

### Testing
- `bunx tsc --noEmit` — zero errors.
- `bun run lint` — zero errors.
- `bun run test` — per-file subprocess runner, must report 0 fail (the runner prints the real count; READ THAT, not a number written here — this line said 265 for three releases after it changed). Any new lib file ships with `*.test.ts`.
- `bun run e2e` — 16 golden-path specs with mock LLM, keep green. Also run `bun run e2e:prod` before shipping; dev and the standalone build diverge.
- **New rule for super-app work**: every new tool in the registry ships with a unit test for its executor + a guardrail test if it touches external systems.

### Code conventions (observed)
- Server-only libs in `src/lib/`, never import `db` or `crypto` into client components.
- Types in `src/lib/types.ts` — single source for client-facing shapes.
- Views in `src/components/views/` — one per nav target.
- API routes in `src/app/api/` — RESTful, multi-tenant (organizationId via Prisma extension).
- Mini-services are independent processes with their own PrismaClient.
- English in all user-facing strings (system prompts, error messages, UI labels).
- Comments explain *why*, not *what*. The codebase already follows this — keep it.

---

## 7. Implementation Roadmap

### Phase S0 — Hardening ✅
- [x] WS service deleted (P1.5) — streaming now via SSE in tool-router
- [x] Stream status updates during SQL/REST execution
- [x] Add retry-on-SQL-error in planner self-correction (G10)
- [x] Documented in README.md

### Phase S1 — Agentic planner ✅ (closes G1)
- [x] `src/lib/planner.ts` — `planQuery()`, `executePlan()`, `synthesizeAnswer()`
- [x] `src/lib/tool-registry.ts` — built-in + plugin tools
- [x] `executePlan()` DAG runner with status emits + self-correction
- [x] API: `POST /api/v1/agent/run` + `POST /api/agent/dashboard` (SSE)
- [x] Tests: planner.test.ts (topoSort, parse, validate)

### Phase S2 — Cognee memory ✅ (closes G2, G3)
- [x] `src/lib/cognee.ts` wrapper (recall, remember, cognify, forget)
- [x] `COGNEE_ENABLED` env flag, local mode (SQLite+Kuzu+LanceDB)
- [x] Chat-turn remember + router recall injection
- [x] Document cognify pipeline
- [x] Tests: cognee.test.ts (8 tests, skip when cognee unavailable)

### Phase S3 — Plugin extensibility ✅ (closes G7)
- [x] `src/lib/plugin-registry.ts` — manifest, executePlugin, SSRF guard
- [x] 9 prebuilt plugins (weather, Wikipedia, translate, calculator, news, etc.)
- [x] `src/lib/plugin-selector.ts` — semantic relevance matching
- [x] External webhook executor with timeout + output cap
- [x] Tests: plugin-registry.test.ts, plugin-selector.test.ts

### Phase S4 — Scale (closes G6, G8) ✅
- [x] `docs/postgres-migration.md` — 7-step migration guide
- [x] Schema Postgres-compatible (String for JSON, no SQLite-specific types)
- [x] Code adaptation (connectors.ts PRAGMA→information_schema, rag-fts.ts FTS5→tsvector)
- [x] Postgres 16 + pgvector + pg_trgm deployed, all demo data migrated (66,435 rows: ERP 72, Chinook 14,926, World 5,298, Pagila 46,211)

### Phase S5 — Automation ✅ (closes G5)
- [x] `ScheduledRun` model + `mini-services/scheduler/` worker
- [x] Notification API (webhook + email + Telegram)
- [x] Scheduler delivers results via notification config

---

## 8. Quick Reference

### Commands
```bash
bun run dev          # dev server on $PORT (3000 default)
bun run build        # standalone build → .next/standalone
bun run start        # prod standalone server
bun run test         # unit tests (per-file runner for mock isolation — read the count it prints)
bun run e2e          # Playwright (16 specs, mock LLM + mock license validator)
bun run lint         # eslint (0 errors)
bunx tsc --noEmit    # typecheck (0 errors)
bunx prisma db push  # apply schema to PostgreSQL
bunx prisma generate # regenerate Prisma client
bash start.sh        # start Next.js + scheduler
bash reset.sh        # reset DB + re-seed
```

### Key files
| File | Role |
|------|------|
| `src/lib/ai.ts` | LLM client, router, SQL gen, answer gen, streaming |
| `src/lib/tool-router.ts` | Dispatcher + agentic confidence loop + streaming dispatcher |
| `src/lib/tool-branches.ts` | Non-streaming branch executors (SQL/RAG/REST/CHAT/Plugin) |
| `src/lib/stream-preparers.ts` | Streaming branch preparers (prepare*Stream) |
| `src/lib/tool-utils.ts` | Shared types + leaf utilities (chart/citation/SQL semaphore) |
| `src/lib/rag.ts` | Hybrid retrieval, chunking, keyword extraction |
| `src/lib/rag-fts.ts` | BM25-style FTS chunk ID search |
| `src/lib/guardrails.ts` | SQL AST validation + mutation block + LIMIT cap |
| `src/lib/connectors.ts` | DB connector registry + schema reflection |
| `src/lib/rest-api-connectors.ts` | REST endpoint matching + auth headers |
| `src/lib/crypto.ts` | AES-256-GCM encrypt/decrypt, session signing |
| `src/lib/embeddings.ts` | Embedding API client + cosine + hybrid fusion |
| `src/lib/vector-stores.ts` | Qdrant/Milvus/INTERNAL vector store abstraction |
| `src/lib/smart-mapping.ts` | Source→entity field maps for routing hints |
| `src/lib/intent-pipeline.ts` | Intent analysis, query rewriting, expansion, reflection, confidence |
| `src/lib/schema-enrichment.ts` | LLM-generated per-table schema descriptions |
| `src/lib/prompt-settings.ts` | Per-tenant system prompt + tool toggles |
| `mini-services/scheduler/index.ts` | Cron-based scheduled run worker |
| `src/app/api/v1/chat/completions/route.ts` | OpenAI-compatible external API |
| `prisma/schema.prisma` | 31 models, multi-tenant, encrypted configs |

### Specs & progress
- `PLAN.md` — overhaul plan (all phases P0–P5 + S4 + RAG complete)
- `README.md` — quick start, commands, project structure
- `docs/postgres-migration.md` — SQLite → Postgres migration guide

---

## 9. Progress Log

> Append a new dated entry per session. Keep it short: what was done, what's next.
> This is the single source of truth for cross-session continuity.

### Ringkasan historis (2026-07-24 → 2026-08-14)

Entri lengkap periode itu dipindahkan ke `docs/progress-log-archive.md` pada 2026-09-25 — lihat
alasan terukurnya di kepala berkas itu. Ringkasnya: audit awal + rencana super-app (G1–G10) → S0–S5
implementasi (planner, cognee, plugin, scheduler, Postgres) → perombakan UI/UX + tema → Smart Router
→ perombakan single-tenant yang **kemudian DIBATALKAN** (multi-tenant tetap dipakai) → konektor DB
nyata + typed errors → arsitektur RAG produksi + migrasi Postgres → perbaikan isolasi tes →
pemecahan `tool-router.ts` → algoritma kualitas P1 (pola LightRAG) → verifikasi UI + audit kontras.

### 2026-09-30 (b) — Release 1.4.0: AI Memory gets its own extraction model, and the sub-menu names its consumer

**Version 1.3.0 → 1.4.0** (minor: a new user-facing capability, no breaking change). Eight stamped locations bumped, CHANGELOG heading cut, `main` fast-forwarded, tag `v1.4.0` pushed, all six image tags verified published, then **deployed and confirmed live** — `/api/v1/health` reports 1.4.0, all six services healthy, and the served `install.sh` updated to 1.4.0 (sha256 identical to the tested copy).

**The sub-menu now says which consumer it configures.** `Chat Configuration` / `AI Memory Configuration` / `Embedding`, replacing "LLM / Embedding / AI Memory" — where two of the three fed DIFFERENT consumers with different credentials and neither name said which.

**Memory can have its own model**, stored as an `LlmConfig` row with `purpose: 'memory'` (the table's unique key is `(organizationId, purpose)`, so no schema change). Extraction is high-volume and structure-bound where a fast model is the better trade, and the previous mechanism was a hard COPY of the chat row. **The fallback is the load-bearing part**: unset means FOLLOW CHAT, so every upgrading install keeps working — verified on production, where no `memory` row exists and the boot log reads `Memory provider shared with cognee: Shared openai/cbcn/deepseek-v4-flash`.

**Storage facts come from the sidecar**, measured live: `relational_db=postgres, vector_db=pgvector, graph_db=kuzu, file_storage=local`. `getCogneeGraphProvider()` was deliberately NOT used as the source — it derives the graph backend from a field its own comment calls INERT, so it is right only by coincidence.

**Two limits found by probing the sidecar, reported instead of worked around:** `save_llm_config` stores provider/model/api_key and has NO endpoint field (four spellings posted, all stored `''`), so the endpoint is saved app-side and surfaced as the exact `OPENAI_API_BASE=` line; and the settings API exposes no embedding parameters, so the Embedding tab REPORTS the memory embedder rather than offering a field that could not take effect.

**Negative-controlled 21/21, and the control changed the code twice** — the recurring value of running it: (1) the test guarding ENCRYPTION of a billable credential asserted only that the mocked encryptor had been CALLED, so a route calling it and storing plaintext passed; it now reads the stored payload and decrypts it back, with the UPDATE arm covered separately (the harness proved those are separate write sites by only breaking one). (2) The rename guard asserted the new label but not the absence of the old, so reverting to `LLM` stayed green.

**Verified:** tsc 0 · lint 0 errors · 300/300 files, 7431 pass, 0 fail · coverage:gate exit 0 (203 gated modules; new route floored at 98 against a measured 99.37%) · e2e dev 18 · e2e:prod 18.

### 2026-09-30 (c) — Release 1.5.0: the memory tab leads with state, and one field that must not be read

**Version 1.4.0 → 1.5.0.** Eight stamped locations bumped, CHANGELOG heading cut, then released and deployed.

**The panel opened with a form; it now opens with the ANSWER.** The two consumers look identical to a compiler and must not look identical to an operator, so the memory tab states which one is in use before offering any field. In the follow-chat state the fields are GONE — a blank form invites a save that would pin memory to the chat model forever, which is the one irreversible-looking action the fallback exists to prevent.

**`mode` is declared in the function signature and deliberately NOT read.** `readSidecarState` decides from `diagnostics.components` presence plus `enabled`/`connected`, because `mode` is unreliable: an ENABLED install whose sidecar is down reports `mode: 'disabled'`, which would libel working memory as switched off. Declaring the field lets the tests hand over the exact server body and assert that changing `mode` alone never moves the verdict — the field that caused the misreading is the one being exercised, rather than the one nobody touches.

**Negative-controlled on the frozen bytes.** Planting `if (data?.mode === 'disabled') return 'off'` breaks "an ENABLED install whose sidecar did not answer is unreachable, never 'off'" (2 fail), restoring byte-identical at md5 `80b94ebd…`. Test diff across the change: **+32 assertions, 0 removed** — no guard was weakened to make it pass. `readSidecarState` was extracted as a testable leaf so the four verdicts are pinned individually rather than only through rendered HTML.

**Verified on the frozen hash:** tsc 0 · lint 0 errors · 300/300 files, 7441 pass, 0 fail · coverage:gate exit 0 (203 modules) · e2e dev 18 · build · e2e:prod 18. Rendered in a real browser at 1440px and 390px: no horizontal overflow at either width, no console errors, the four store rows render, mobile stacks to one column.

**A process note worth keeping.** The e2e modes were NOT re-run by the implementer after its final edit, and it said so rather than implying otherwise — which is why the two runs above were measured by a second party on the frozen file. An unverified claim flagged as unverified costs nothing; the same claim left implicit would have shipped.

### 2026-10-01 — Release 1.6.0: a live IDOR, a cross-tenant PII leak, six row-cap bypasses, and three silent-failure classes

**Found by a 10-agent read-only audit, each finding then reproduced by hand before it was accepted.** Two of the agents were wrong in ways worth recording: one asserted a guard's content from its comment without reading the assertion (it withdrew the claim), and one reported "both runners agree" when their globs differed 303 vs 290 — the correction came from the Lead's own check.

**A live cross-tenant IDOR.** `Order` carries `organizationId` but was missing from `ORG_SCOPED_MODELS` (30 models have the column, 28 were scoped). Proved by driving the real extension handler: `Document.findFirst` forwarded `{"where":{"id":"x","organizationId":"org-PROBE"}}`, `Order.findFirst` forwarded `{"where":{"id":"x"}}`. `GET /api/billing/orders/[id]` therefore served any org's order from a client id — while its docstring claimed the extension scoped it, which is why nobody re-checked. Fixed, docstring corrected, and `tenant-scope-coverage.test.ts` now PARSES the schema and asserts the set equals the scoped list plus an explicit justified exception (`invitation`), so a new unscoped model fails the build naming itself.

**A cross-tenant PII leak.** The LLM trace ring buffer is a module-global with NO org field, and `/api/traces` called `enterWithOrg(...)` then never used it — passing the static tenant-route guard while being effectively unscoped, with no `requireRole`. Any authenticated user read the last 20 prompt bodies of EVERY tenant. Now stamped per org, filtered on read, admin-gated. The trap is documented in both routes: **`enterWithOrg` alone is NOT scoping when the data is in-process memory rather than a Prisma query.**

**Six row-cap bypasses, and two corruptions introduced while fixing them.** `LIMIT ALL`/`NULL` returned byte-identical SQL; MySQL's `LIMIT a, b` clamped the OFFSET and left the COUNT at a million; `FETCH FIRST`/`TOP` got a second invalid `LIMIT` appended (a syntax error on MSSQL); `1_000_000`/`1e10` matched nothing. All clamp correctly now. The first fix then corrupted a STRING LITERAL (`'LIMIT 999999'` → `'LIMIT 100'`) and a DELIMITED IDENTIFIER (`[Credit Limit 5000]` → a different column; an aliased form changed the result set's field names while the query still succeeded) — caught by a second reader, fixed by clamping over masked SQL and splicing by offset, with masking extended to backtick/bracket identifiers keyed on bracket CONTENT so a PG array subscript stays visible.

**A 631-line rewrite was DISCARDED rather than wired in.** It had zero callers (`grep enforceRowCap` → one comment): a fix in a place that could never run (class 9). Direct measurement showed it produced invalid syntax on `FETCH`/`TOP` and never applied `Math.min`. Deleting it and fixing the shipped 12-line clamp was the smaller, safer change.

**Three silent-failure classes.** (11) The planner's system prompt measured 3023 chars against a ~2000 ceiling and was discarded whole — the rules MOVED to a `user` role (moved, not deleted; a test asserts every rule still arrives), 3023 → 579. The same guard then found a THIRD instance: `historyToMessages` embedded the entire history a second time, 20,116 chars on ten turns, discarded every time and paid for twice. (14) The container healthcheck probed `/api/v1/health`, which touches nothing and always answers ok — so a dead Postgres still reported `healthy`. Now probes `/api/health`; only `db` is CRITICAL, the other four are reported so an optional blip cannot restart-loop a healthy container. (13) `license-client.ts` stored `data.plan` verbatim, and an unrecognised plan resolves to `starter` — the MOST restrictive tier — so a renamed plan would cripple a flat-licence install with no test able to catch it (the e2e mock defaults unknown keys to `enterprise`). Now normalised at the boundary, unrecognised values dropped and logged.

**Suite 40s → 20s, and two fail-open gates closed.** The wall time was ONE file: `ai.test.ts` 38.8s, of which 11 tests × 3.5s was pure backoff `setTimeout` (concurrency 8→32 moved it <0.8s, proving a critical path). `LLM_RETRY_BACKOFF_BASE_MS` is now env-overridable with the default UNCHANGED. The two runners globbed different sets (303 vs 290), so 13 benchmark suites ran but were never measured; both now share one `TEST_FILE_GLOB` with a parity guard. `coverage.ts` never exited non-zero on an inner failure and wrote a `failedTestFiles` field with no reader; `coverage-gate.ts` exited 0 when its summary was missing.

**Seven floors re-derived, not loosened.** Each sat above its measurement because the files grew (guardrails 454 → 611 lines). Reset to measured-minus-one with the number and reason recorded. The gate's own refusal path was respected rather than bypassed.

**Verified:** tsc 0 · lint 0 errors · 307/307 files, 7599 pass, 0 fail · coverage:gate OK (203 modules) · e2e dev 18 · e2e:prod 18 · `docker compose config` rc=0 on both composes. Negative controls restored byte-identical throughout, including one that reproduced the ORIGINAL leaks (an analyst got HTTP 200 when `requireRole` was deleted).

**Recorded rather than hidden:** arithmetic counts (`LIMIT 1000000*100`) and `TOP n PERCENT` cannot be bounded by a lexical clamp — both pinned as DOCUMENTED GAP tests so the absence stays visible. A deliberately-failing negative-control artifact (`zz-nc-plant.test.ts`) was left in the tree by a subagent and removed; it was the cause of a transient 8-failure suite run.

### 2026-10-01 (b) — v1.7.0–v1.7.2: faster answers, a security pass, two corrections

**v1.7.0 = latency, v1.7.1 = the batch after it, v1.7.2 = two defects found by reviewing 1.7.1** (a cancelled request was classed as a timeout; a safety test passed with no build on disk). Details in `docs/latency-reference.md`; measured on
15 policy questions x3, on one machine.

- Median time to first token **9.3 s → 7.6 s**, LLM calls before it **4.7 → 3.7**, and first-token p95
  **43.3 s → 11.3 s** once `fetchWithRetry` stopped retrying TIMEOUTS (it retried the one failure that
  had already spent the full 30 s budget, up to four times). That retry also cost ACCURACY: 3 of 12
  tool-selection calls returned `null` on a transport timeout, and `null` silently falls back to the
  heuristic router. A 5xx and a connection error still use the full ladder.
- Tool selection starts ALONGSIDE intent analysis (`SPECULATIVE_ROUTING=false` restores serial order);
  a multi-phrasing query is reranked ONCE, not once per phrasing; cognee's two recall strategies run
  concurrently (MEASURED on production: 565 ms + 536 ms were serialised on every turn).
- A per-turn breakdown reaches the `done` frame and `/api/metrics`
  (`chat_first_token_ms`, `chat_turn_total_ms`, `chat_pre_token_llm_calls`), and
  `benchmark/latency-eval.ts` refuses a change that makes a previously-correct answer wrong.
- Citation snippets show the chunk's own text (they showed the document's context prefix, so three
  sources of one document displayed the same 240 characters).

**Rejected with evidence, not re-open blindly:** turning the reranker off is fastest (median → 5.3 s)
but on this corpus the answer chunk is already first after fusion in 13 of 14 answerable questions, so
"no regression" could not have failed; and the rerank score cannot replace the reflection check — the
compound question scored 10 while reflection correctly called the evidence insufficient.

**Security: 130 advisories → 0** (`bun audit`; v1.7.1 left 2, closed in v1.7.3 by overriding `deepmerge-ts`/`effect`). `next` 16.1.3 → 16.3.8 fixes two CRITICALS fixed only
in ≥16.3.3, one of them an unauthenticated RCE in the Image Optimization API — live here, because the
login screen calls `next/image`. The declared range `^16.1.1` would have reinstalled a vulnerable
version on the next install, so the floor is now asserted by a test. `prismjs` is pinned to 1.30.0 by
override (`react-syntax-highlighter → refractor@3.6.0` pulls `~1.27.0` into a CLIENT chunk). `deepmerge-ts`
and `effect` are pinned exactly by `@prisma/config@6.19.2` (prisma CLI only); v1.7.3 overrides them after
running migrate's real command inside the real scheduler image. `dependency-security.test.ts` asserts all three.

**Two audit findings were WRONG, corrected here.** The HNSW index is PRESENT in production
(`DocumentChunk_embedding_hnsw`, checked with `pg_indexes`), and three of the four "missing indexes"
have no query that would use them — only `Document(organizationId, status, isEnabled, createdAt)` was
real and is added.

**A real bug: `restoreDocVersion` orphaned the knowledge graph.** It deleted a document's chunks and
re-inserted them without touching `KgRelation`, whose `chunkId` names a chunk id — MEASURED, 131 of 131
rows orphaned in a development database, 0 in production. Fixed in the same operation. **The FK was
deliberately NOT added**: `prisma db push` runs in `migrate` on EVERY boot BEFORE the app starts, and
on a clone holding those rows it exited non-zero ("violates foreign key constraint"), so an affected
install would stop booting. `scripts/cleanup-kg-orphans.ts` handles an install that already has
orphans; on the clone the push succeeded once it had run.

**A negative control caught a vacuous test TWICE.** The cleanup first chained `.catch()`, which does
NOT catch a synchronous throw from an absent `kgRelation` delegate — the throw aborted the restore
after the chunks were already deleted. Its test then survived its own control twice: `delete
dbMock.kgRelation` reads as undefined (so `.catch()` caught the TypeError after all), and swapping
`dbMock.db` after import changed nothing because the reference was already bound. It now throws on
property ACCESS through a Proxy installed before the import, and the old form fails it.

**Verified:** tsc 0 · lint 0 errors · 313 files, 7664 pass, 0 fail · coverage:gate OK · e2e 19 ·
build · e2e:prod 19.
