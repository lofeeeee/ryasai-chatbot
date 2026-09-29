# Billing and editable context prompts — reference

Both sections were moved out of `AGENTS.md` on 2026-09-29 for a MEASURED reason: `AGENTS.md` (59,565 bytes) plus
`CLAUDE.md` (37,433) came to 97 KB against an instruction budget of 65,536, so `AGENTS.md` was truncated and the
rules below byte ~28,000 — including `## Cross-tenant IDOR` and `## Silent-failure classes` — never reached an
agent. These two are reference material, read when billing or prompt injection is being worked on; the rules stayed.

`## Deployment model` in AGENTS.md is the section that matters for the business model — read it first. In short:
the signed LICENSE is the entitlement, there is no usage metering, and the customer's own LLM key pays for tokens.

## Billing: the signed license IS the revenue model (not subscriptions or metering)

> Keep this section for the QRIS purchase-flow mechanics, but do not read it as a
> metering roadmap — see "Deployment model" above. The entitlement is a signed,
> machine-bound license issued by OUR validator; there is no per-token or per-seat
> charge to reconcile, and the customer's install runs with the customer's own LLM key.

Billing via QRIS is IMPLEMENTED (spec: `docs/superpowers/specs/2026-08-26-qris-billing-design.md`):
Midtrans Snap checkout, flat `'flat'` plan (all features), packs 1/3/6/12 months
(`src/lib/pricing.ts`), register-free → locked-until-paid (`licenseStatus 'unpaid'`),
webhook-driven license issuance via the License-Validator's
`POST /internal/licenses/generate` (X-Internal-Secret auth, in `~/ryasai/ryasai-LicenseValidator`,
separate repo). Key pieces: `src/lib/midtrans.ts`, `src/lib/license-issue.ts`,
`src/app/api/billing/*`, buy-license dialog, `license-expiry-reminder` scheduler job.
New env: `MIDTRANS_SERVER_KEY`, `NEXT_PUBLIC_MIDTRANS_CLIENT_KEY`, `MIDTRANS_IS_PRODUCTION`,
`NEXT_PUBLIC_MIDTRANS_IS_PRODUCTION`, `LICENSE_INTERNAL_SECRET`.

Still open before charging real customers:

- **Plan quotas are now ENFORCED** (2026-09 audit): `checkQuota()` / `quotaFor()` /
  `quotaExceededMessage()` in `plan-gating.ts` gate every resource-creation path —
  `maxIntegrations` in `POST /api/integrations` (checked BEFORE the connection test, so a
  refused create costs no round-trip to the customer DB and does not surface as
  "Connection failed"), `maxDocuments` in `POST /api/documents` (before extraction/
  embedding, so no embedding call is wasted), and `maxUsers` in `accept-invite` plus BOTH
  SSO provisioning paths (`sso.ts`, `sso-saml.ts`). Signup/register are deliberately NOT
  gated — they create a fresh org whose first user is always within quota; gating them
  would lock a new customer out of their own account. Refusals are HTTP 402 with
  `code: 'QUOTA_EXCEEDED'`. An unknown/null plan resolves to `starter`, the MOST
  restrictive tier, so a typo'd plan cannot unlock the largest quotas. `invariants.test.ts`
  pins the wiring by asserting on the actual `checkQuota(...)` invocation rather than on a
  nearby string, and forbids a hardcoded `{ allowed: true }`; both guards were
  negative-controlled (a disabled `if (false)` with the QUOTA_EXCEEDED string still present
  initially slipped past a weaker version of the guard).
  **Known limit — do not overstate**: this is a check, not a lock. Two concurrent creates
  can both read `current = limit - 1` and overshoot by one. Acceptable for a commercial
  boundary; if a quota ever gates something expensive or security-relevant it must be
  re-implemented as an atomic check-and-insert.
- **SSO provisions into an explicitly-resolved org, never a hardcoded one**:
  `resolveSsoOrganizationId()` (`sso.ts`) uses `SSO_ORGANIZATION_ID` when set, otherwise
  accepts the single-org case, and **throws** when several orgs exist. INCIDENT (2026-09):
  both SSO providers wrote the literal `'org-default'`, a leftover from the reverted
  single-tenant refactor. `User.organizationId` is a foreign key, so on a real multi-tenant
  DB that insert threw an FK violation — first-time SSO login was simply broken, and no test
  caught it because the `db` mock accepted any value. Guessing a tenant instead would be
  strictly worse than the FK error (cross-tenant attribution), hence fail-closed.
- **License-Validator deployment story** is undocumented (issue/revoke/machine-slot ops live in that other repo).
- No trial path — deliberate choice (locked until paid); revisit if conversion suffers.
- `LLM_DAILY_TOKEN_BUDGET` is opt-in (default off) and dormant. It is a runaway-loop safety valve, NOT the revenue mechanism and NOT a per-org ceiling anyone asked for (see "Deployment model" above).
- Quality evals (`rag-eval`/`sql-eval`) run only via the manual/scheduled `eval.yml` workflow — no hard CI gate on answer quality.


## Editable context prompts (spec: `docs/superpowers/specs/2026-08-26-editable-context-prompts-design.md`)

Admins can attach free-text prompts that shape LLM answers per source:
- `Document.contextPrompt` → injected into RAG answer synthesis (only when that doc's chunks are retrieved). Editor: Knowledge view → document "Details" dialog.
- `Integration.contextPrompt` → injected into SQL synthesis (both the SQL-generation step and the final answer prose). Editor: Data Sources view → integration "Schema" sheet.
- Org-wide `ragContextPrompt` (in `AppConfig.promptSettings` JSON) → every RAG answer. Editor: Prompt & Tools view.
- Org-wide `systemPrompt` (existing, same JSON) → chat + agentic. The Prompt & Tools editor now has char counters, a default-template button, and injection explainers.
- Per-table `IntegrationSchema.description` is admin-editable and `manualDescription`-locked: `enrichSchemaDescriptions` skips locked rows, and schema `?refresh=1` carries locked descriptions + flags across re-reflection (older code wiped them on every refresh).

Injection helper: `buildSourceGuidance()` (`src/lib/source-guidance.ts`) — budget-capped (2000 chars), preserves retrieval order, truncates with an ellipsis marker, notes omitted prompts. RAG branch prepends the block to the evidence `context` (not as a system message); SQL branch appends `Context guidance:` to the effective prefix for both `generateSql` and `generateAnswer`. Empty prompts are no-ops. All writes are admin-only + audit-logged.

Post-audit hardening now in place: billing webhook uses a conditional settlement claim
(race-safe) + hourly `order-reconcile` sweep for settled-but-unissued orders +
gross_amount validation; env validation is fatal for missing DATABASE_URL/
ENCRYPTION_SECRET_KEY and prints a consolidated degradation warning block otherwise;
install.sh requires an operator-supplied LICENSE_SIGNING_PUBLIC_KEY; web-fetch follows
redirects manually with per-hop SSRF checks; chat send has org rate limit
(`CHAT_RATE_LIMIT_PER_MIN`) + optional spend budget; `/api/metrics` is token/admin-gated;
document jobs have retry (`POST /api/documents/[id]/reprocess` + UI button); purchase
flow is e2e-tested via mock Midtrans (:4547, `MIDTRANS_BASE_URL` test seam).

**Remove before shipping a customer image — VERIFY, do not assume:**
- Demo data paths (`scripts/migrate-demo-to-postgres.ts` demo DBs, `connectors.ts` demo tables,
  `test-data/` PDFs). **Checked against the actual build:** `.dockerignore` excludes
  `test-data/`, and `.next/standalone/` ships only `node_modules`, `public` and `server.js` —
  so neither the PDF fixtures nor `scripts/` reach the customer image today. The last
  remaining reference was a COMMENT in `prisma/schema.prisma` listing `SQLITE_DEMO` among the
  allowed providers. Checked before acting on it: `SQLITE_DEMO` appears NOWHERE in `src/` — the
  demo connector was already removed, and the UI offers only POSTGRESQL / MYSQL / MSSQL — so the
  comment was the last trace of a capability that no longer exists. Removed. The checklist item
  is therefore CLOSED, not carried forward.
- `helm/` chart lags docker-compose — `helm/README.md` carries a NOT-PRODUCTION-READY
  banner and a divergence table; don't point customers at it until reconciled (compose +
  `install.sh` are the supported path).

Resolved by the 2026-09 audit (kept here so they are not re-introduced):
- Dev artifacts `dev.log` / `README.md.bak` / `tsconfig.tsbuildinfo` deleted (all were
  gitignored but dirtied every `git status`).
- Stale docs corrected: `docs/adr/0001` is now marked SUPERSEDED in place (body preserved
  for the reasoning); PRODUCT.md/PRD/threat-model/helm claim multi-tenant + English and
  the re-derived counts (31 models, 99 routes, 12 views).
- Benchmark run artifacts are gitignored (`benchmark/results/*.json`, keeping the
  curated `ground-truth-failures.json`) so they stop polluting the working tree.

