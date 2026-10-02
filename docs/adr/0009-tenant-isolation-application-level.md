# ADR 0009: Tenant Isolation at the Application Layer

**Status:** Accepted  
**Date:** 2026-10-02

## Context

Every data model in the schema carries `organizationId`, and `Organization` is the tenant root:
`User.organizationId` links a user to one org, and a single install can host several orgs (signup
creates one). Cross-tenant isolation therefore has to be enforced somewhere, and the textbook answer
is PostgreSQL Row Level Security — policies on each table keyed to a session variable, enforced by
the database itself regardless of what the application does.

**The measured constraint is the connection pool.** An RLS policy reads a session GUC such as
`app.current_org`, which the application must set per request. Prisma's pool shares connections
across concurrent requests and offers no per-request channel for `SET LOCAL app.current_org`:

- `SET LOCAL` is only visible inside the transaction that issued it, so it would have to ride on a
  connection dedicated to that request. The pool does not hand out dedicated connections, so this
  means connection-per-request — a pool shape Prisma does not support, and one that would multiply
  Postgres backends on a host the installer already caps at `max_connections=40`.
- A session-level `SET app.current_org` persists on the pooled connection after the request returns,
  so the *next* unrelated request that borrows that connection inherits the previous request's org
  id. Under RLS that is worse than having no RLS at all: every subsequent query on that connection
  is silently scoped to one tenant, and the wrong results look like correct ones.
- Correct per-request GUC scoping therefore requires a dedicated proxy or pooler that assigns one
  org-scoped session per request. This product's deployment shape — a single on-prem instance per
  customer, one app container plus one scheduler against one Postgres — has no such component and
  no room to add one on the 1 vCPU / 1GB host the installer targets.

Two things in this repository's history make the decision worth writing down rather than leaving
implied. An earlier "single-tenant refactor" that removed `organizationId` was **reverted** — the
multi-tenant shape is load-bearing even though the money model is one flat license per install,
because the org scoping is what every other security guard in the codebase depends on. And two
notes once described the extension as though it handled isolation by itself; the extension is real
but it is application-layer, and its limits (raw SQL, `findUnique`, in-process memory) are exactly
where the incidents were found.

## Decision

Tenant isolation is enforced at the application layer, and that **is** the boundary — not a
stopgap awaiting RLS. Five mechanisms, each with its own guard:

1. **Injection, not hand-writing.** The Prisma client extension (`src/lib/prisma-tenant.ts`)
   injects `organizationId` from `AsyncLocalStorage` into `findFirst`, `findMany`, `count`,
   `aggregate`, `groupBy`, `update*`, `delete*` and `create*`. No query author writes the org
   filter, so it cannot be forgotten per query.

2. **Context entry is per route handler.** `enterWith()` does not propagate back to the caller's
   frame, so every handler must call `enterWithOrg((await getActiveUser()).organizationId)` itself
   right after resolving the user. `src/lib/tenant-route-guard.test.ts` enforces this statically
   and fails on a new route that omits it.

3. **Coverage is asserted, not assumed.** `src/lib/tenant-scope-coverage.test.ts` checks that
   org-scoped models are actually covered by the extension; it exists because a model missing from
   the scoped set (`Order`, in the 2026-10 release) produced a live cross-tenant IDOR that the
   per-route guard could not have caught — the route called `enterWithOrg` correctly, and the
   query ignored the context it established.

4. **`findUnique` is the known hole, and it is allowlisted.** A unique `where` cannot carry an
   injected `organizationId`, and IDs *are* returned to clients (an MCP list route returns
   `id: true`), so a cuid is not a secret. `invariants.test.ts` fails on any file outside an
   explicit allowlist that uses `findUnique`; the permitted cases are pre-auth lookups where no
   org exists yet (login, signup, invite, setup) and re-reads of a row the same handler just
   created.
5. **RLS is opt-in, not the boundary.** `scripts/enable-rls.ts` (added separately) lets an operator
   turn on database-level policies as defense-in-depth. Installs run correctly without it, and
   nothing in the application depends on it being present.

Two related boundaries sit alongside this one and are *not* part of it. `bypassOrg(fn)` is the
escape hatch for setup, SSO, signup and seed paths where no org context exists yet — used
deliberately for those cases, not as a shortcut around scoping. And `AsyncLocalStorage` scopes
**database queries only**, not process-global in-process memory, which is why a shared trace ring
buffer needed its own org check after it leaked cross-tenant PII. Application-layer isolation has
to be reasoned about per storage surface, not once for the process.

## Consequences

- **Positive:** works on the shipped single-instance deployment with no additional component; the
  org filter is injected rather than hand-written, so the per-query failure mode (a developer
  forgetting a `where`) is designed out rather than reviewed for.
- **Positive:** the regression classes this repository has already been bitten by — missing
  `enterWithOrg`, a model dropped from the scoped set, `findUnique` on a client id — each have a
  named static guard that fails CI, instead of relying on a reviewer to notice.
- **Negative: raw SQL is the author's responsibility.** The extension does not rewrite
  `$queryRaw` / `$executeRaw`. Three such sites read tenant data (`rag-retrieval.ts`,
  `rag-fts.ts`, `knowledge-graph.ts`), and each carries its own explicit `"organizationId" = ?`
  predicate with the org id as a bound parameter. A fourth raw-SQL file (`connectors.ts`) seeds
  demo data and touches no tenant rows. A new raw query must remember the filter, and no static
  guard currently enforces that it does.
- **Negative: DBA access bypasses the boundary.** Anyone with credentials to connect to Postgres
  directly reads every tenant's rows. That limitation is not specific to this choice — it holds
  for any application-level scheme, and for RLS too unless the DBA role is excluded from the
  policies. It is recorded here because "application-layer" must not be read as "database-enforced".
- **Neutral:** the opt-in RLS script gives defense-in-depth where an operator wants it, without
  making the database a prerequisite for correctness in the default install.

## Alternatives

- **RLS as the boundary:** rejected on the measured pool constraint above — not on difficulty,
  but because the only correct forms (connection-per-request, or a session-scoped `SET` on a
  dedicated per-org pooler) are components this deployment shape does not have.
- **Hand-written org filters on every query:** rejected — the 2026-09/10 audits found the leaked
  routes were exactly the ones where a filter could be forgotten; injection plus static coverage
  makes forgetting impossible rather than merely discouraged.
- **Postgres multi-database-per-tenant:** rejected — `prisma db push` runs on every boot in the
  `migrate` service, which drops unknown empty tables silently and refuses to boot on unknown
  populated ones; per-tenant databases would multiply that risk and break the single-connection-string
  install.
