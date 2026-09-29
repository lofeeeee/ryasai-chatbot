# CLAUDE.md — ryasai Chatbot (Super-App Track)

> Living document. Update the **Progress Log** at the bottom every session.
> Last updated 2026-09-29. Version 1.1.1. PostgreSQL 16. All PLAN.md phases P0–P5 + S4 + RAG complete. Language standardized to English.
>
> **Counts and versions in this file drift.** Section 1 and 8 describe CURRENT state and are
> corrected to 1.1.1; section 9 (Progress Log) is HISTORICAL and its numbers were true when
> written — do not "fix" them. When you need a number, run the command. (Section 2 was three
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
| Status | **Release 1.1.1** (2026-09-29). Verified by execution, not assertion: `tsc` 0 · `lint` 0 · `bun run test` 289/289 files, 7206 pass, 0 fail · `e2e` dev and `e2e:prod` both green in CI |
| Version | 1.1.1 |
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

### 2026-09-25 — Release 1.0.0: memory integration replaced, and a guard that proved nothing

**Version aligned to 1.0.0** in all six places it was stamped (package.json, .env.example,
install.sh, and the two code fallbacks + otel) — they had drifted to FOUR different numbers
(0.4.0 / 2.0.0 / 0.5.0 / 0.0.0), and the code fallbacks are what the customer's UI actually
displays (the Dockerfile declares no `ARG`, so `NEXT_PUBLIC_APP_VERSION` from `.env` never
reaches the bundle). CHANGELOG converted from a two-month-old `[Unreleased]` into `[1.0.0]`.

**Cognee: one backend, one version, one writer.** Removed `@cognee/cognee-ts` entirely and moved
memory to a pinned **cognee v1.6.0 API server**; with no `COGNEE_SERVER_URL` memory is OFF rather
than half-wired. Reason is measured, not stylistic: two lineages writing one store produced a
collection sized 1536 while the embedder returned 384, and a graph with 0 nodes after a write
that reported success. Cross-session recall now works and is measured (write ~9s warm, recall
0.21-0.35s from a different session, found by a semantic query too).

**Latency, localized honestly.** Write latency is the CUSTOMER's model, not this code: measured
on their endpoint, "Say OK" answers in 1.3s while an extraction request takes 23.7s. All four
write sites are fire-and-forget, so an answer is never blocked — the cost is memory FRESHNESS.
Two claims I made and then retracted with the refuting numbers are recorded in
`docs/cognee-http-migration.md`.

**A guard that proved nothing — the most valuable find of the session.** Following the discipline
of negative-controlling every guard: deleting the real `startJobWorker()` CALL from
`src/instrumentation.ts` left the suite at **49 pass, 0 fail**, because the assertion was
`toContain('startJobWorker')` and the name survives in the import one line above (a comment
satisfied it too). That guard exists for the repo's most expensive known outage (40 document jobs
stuck 16+ hours). It now strips comments and requires an INVOCATION. Two other guards were
audited and held (cognee searchTypes; the SQL deny-list, which was already written against a call
count).

**Also fixed:** the chat UI could drop an in-flight answer and then drop it silently (both fixed);
e2e now clears the BullMQ queue as well as Postgres (orphaned jobs were leaving a document
without a vector and failing a citation assertion); `adoptStuckJobs` renamed — it never adopted
anything.

**Verified by execution, not assertion:** `tsc` 0 · `lint` 0 · `bun run test` 265/265 files,
6825 pass, 0 fail, 71 skip · `bun run e2e` 16/16 (dev) · `bun run e2e:prod` 16/16 against the
standalone build, which reports version 1.0.0 and ships no `@cognee`.

**Known and documented, not hidden:** the provider occasionally returns an empty body for an
extraction call (rare, not reproducible on demand; retries recover it — 184 of 297 first-attempt
validation failures eventually succeeded). The exact trigger is outside this codebase.

### 2026-09-26 — Real-LLM probing: 12 silent-failure classes, and a prompt that was never delivered

Work this session was driven by one method: run the PRODUCTION pipeline against the customer's real
provider and real business data, then chase down anything that looked wrong. Twelve defects shared
one shape — the code reported success for work it had not done, or dropped data on the way out.
They are catalogued with measurements in `AGENTS.md` ("Silent-failure classes found by probing").

**The two most consequential were both about DELIVERY, not logic:**

- A routing bug sent document questions to SQL. The `datetime` plugin declares the bare keyword
  "tahun", so 5 of 6 database questions containing a time word were promoted OFF the route the
  classifier had chosen — and the WRONG answer scored HIGHER ("Tampilkan pesanan per jam." 0.415 vs
  "Hitung 15% dari 2 juta." 0.383), so no threshold could separate them. A question answerable only
  from a document had been returning "the data does not contain that". Fixed with a subject-match
  gate; the same question now returns the planted token `ZQX-4471` with its citation.
- The intent system prompt was 2872 characters and the Text-to-SQL rules 3033, against a provider
  ceiling of ~2000 for a SYSTEM message. Measured: 1800 chars reports `prompt_tokens` 411, 2100+
  reports 44 (the user message alone), 3/3 reproducible. Both prompts were therefore discarded on
  EVERY request. User messages have no such ceiling. This also explains an earlier round where a
  prompt rewrite changed behaviour by exactly 0/4 — there was nothing to ignore.

**A ambiguous question was answered with a confident guess.** "Berapa banyak itu?" (a pronoun with
no antecedent, which the prompt has always listed as needing clarification) produced
"Jumlahnya 2.405 (total stok)" — picked from one of three connected databases. A downstream guard
suppressed clarification whenever the question contained "berapa", which is exactly what the
ambiguous shapes contain. The rule moved into CODE, because two prompt rewrites changed it by 0/4.

**Also fixed:** `extractError` dropped the actionable `hint` on 48 callers; `fetchProviderModels`
never read the response body so BYOK failures could not be classified; a transport failure surfaced
to the customer as Bun's raw "Unable to connect" with an empty hint; `resetCognee` reported a
successful wipe when the forget had failed; `GET /api/documents/[id]` selected `cognifyStatus` and
never mapped it.

**This file was silently truncating itself.** Measured: `CLAUDE.md` was 90719 bytes against a
65536-byte read budget, and truncation keeps the HEAD — so the 2026-09-25 entry (starting at byte
87712) was never read, in a file whose own header calls the Progress Log "the single source of truth
for cross-session continuity". Entries through 2026-08-14 moved to `docs/progress-log-archive.md`;
`CLAUDE.md` is now 33584 bytes and the newest entry starts at byte 30577. `AGENTS.md` had the same
problem at 66057 and a duplicated section; both fixed.

**Verified by execution:** `tsc` 0 · `lint` 0 · `bun run test` 267/267 files, 6858 pass, 0 fail,
71 skip · benchmark 167 · invariants 49 · e2e dev 16/16 and e2e:prod 16/16. Every fix carries a
negative-controlled guard: plant the violation, confirm the guard FAILS, restore, confirm it passes.
One guard written this session survived its control and was rewritten — a test that cannot fail is
worse than no test, because it reports safety.

**Still open, recorded rather than hidden:** memory-write latency is the customer's model (a 23.7s
extraction call vs 1.3s for "Say OK"), all write sites are fire-and-forget so answers are never
blocked; memory FRAMING shows no measurable effect (14/15 vs 14/15, unproven); the provider
occasionally returns an empty body and retries recover it.

### 2026-09-29 — Repo cleanup: 63 dead files, a duplicated implementation, and a truncated instruction file

**The instruction budget was the real defect.** `AGENTS.md` (59,565 B) plus this file (37,433 B) came to 97 KB against
a 65,536-byte read budget, and truncation keeps the HEAD — so everything in `AGENTS.md` past byte ~28,000 was
silently dropped, including `## Cross-tenant IDOR` (a real IDOR incident) and `## Silent-failure classes` (20 defect
patterns). The rules an agent most needs were the ones not being delivered. Fixed by MOVING reference out, not by
deleting content: `docs/architecture-reference.md` (pipeline internals + this file's audit summary and algorithm
sketches), `docs/billing-and-prompts-reference.md`, `docs/build-and-deploy-reference.md`. Now 55,084 B total, every
rule section inside the budget, and each moved section left a pointer that states why it moved.

**Dead files, found by measurement after a wrong first answer.** `grep -r` claimed 46 orphan modules including
`chat-view.tsx` — obviously false, because a recursive grep matches a file's own contents and matches SUBSTRINGS (it
"found" a consumer for an unused `toggle.tsx` via the local `toggleSidebar`). Replaced with specifier resolution,
kept as `scripts/audit/dead-modules.mjs`. Real result: 2 shadcn components (`toggle.tsx`, `use-mobile.ts`) and
`__connector-mocks.ts` — the last a FAILED EXTRACTION whose richer mocks nobody imports while `rag-fts.test.ts`
defines its own inline.

**61 files at the repo root (6.2 MB)** — screenshots, DOM dumps, probe JSON — had all landed in ONE commit whose
message is about a guardrail fix, because nothing ignored them. Removed after verifying each was unreferenced (which
is how `views.json` was caught as a false positive rather than reported live). `.gitignore` now blocks the SHAPES
they take, scoped to the root: a global `*.png`/`*.txt` would silently hide the next asset in `docs/screenshots/` or
`test-data/wikipedia/` (24 such files are tracked today). `coverage-summary.json` is deliberately NOT ignored — it
looks like a build artifact and is an INPUT the gate reads.

**`dedupeByPrefix` existed twice**, as `dedupeByPrefix` and `dedupeJoin`, differing only in whether they joined the
result. The memory copy's comment said "mirrors the KB recall path" — a note documenting duplication instead of
removing it. Consolidated into `cognee-core.ts` ("shared helpers", imports neither caller, so no cycle).

**Consolidating it exposed a vacuous guard.** The dedupe test used `'P'.repeat(100)` for both hits, so changing
`slice(0, 100)` to `slice(0, 50)` left the file at 45 pass / 0 fail. It now pins the boundary from both sides and
fails in both directions. Building it also required measuring that one call issues FOUR HTTP recalls, not two.

**Eight coverage floors quoted a stale measurement**, and the gate surfaced it (`cognee-memory` floored at 62 against
a real 61.42%). `rag-retrieval.ts` claimed 70.79% against 62.72%; `tool-router.ts` claimed 62.62% against 54.44%. A
stale number there is worse than none — it looks like evidence and answers the question wrongly. All 11 refreshed,
and `coverage-floor-consistency.test.ts` now fails when a comment stops matching `coverage-summary.json`, when a
floor sits above its measurement, or when a floor names a file the summary no longer measures.

**Verified:** `tsc` 0 · `lint` 0 · 289/289 files, 7206 pass, 0 fail, 71 skip · coverage:gate exit 0.
