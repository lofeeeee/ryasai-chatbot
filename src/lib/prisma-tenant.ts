/**
 * Prisma tenant extension — auto-injects organizationId into all queries.
 * ----------------------------------------------------------------------------
 * Uses AsyncLocalStorage to track the current org context. When a request
 * comes in, getActiveUser() calls enterWithOrg(orgId). Every subsequent Prisma
 * query on org-scoped models automatically gets organizationId injected into
 * the where clause (reads) and data object (creates).
 *
 * Escape hatch: bypassOrg(fn) runs a callback without org scoping — used by
 * SSO login, signup, setup wizard, and seed scripts where no org context
 * exists yet or explicit org control is needed.
 *
 * ponytail: findUnique is NOT scoped (can't add non-unique fields to unique
 * where). The original rationale here was "IDs are cuid() random — cross-tenant
 * access by ID is infeasible", which is security-through-obscurity and was
 * measurably FALSE: `api/mcp/servers/route.ts` returns `id: true` to the browser,
 * so a legitimate org-A user holds their own server IDs in plain sight and those
 * IDs resolve in org B's context. Two routes were exploitable this way
 * (`mcp/servers/[id]` GET/PATCH/DELETE, and `chat/sessions/[id]/send` reading
 * `body.promptId`), both of which DO call getActiveUser()+enterWithOrg() — so
 * their ritual was correct and the org context was simply ignored by the query.
 *
 * Fix direction: use `findFirst` (or `findFirstOrThrow`) with the ID in the
 * where clause when you are loading a row by a client-supplied identifier. The
 * extension then injects organizationId automatically and a cross-tenant ID
 * yields null instead of another tenant's row. `findUnique` remains legitimate
 * for (a) pre-auth lookups where no org exists yet (login, signup, invitation
 * tokens) and (b) re-reading a row this same handler just created.
 *
 * Ceiling: this is a convention, not a guarantee — the extension cannot rewrite
 * findUnique because Prisma's unique `where` rejects extra fields. So a new
 * `findUnique({where:{id}})` on a client-supplied ID is a silent regression.
 * `src/lib/tenant-route-guard.test.ts` now fails on that pattern; keep it green.
 *
 * THERE ARE TWO INDEPENDENT WAYS ISOLATION IS LOST HERE, and the first one hid
 * behind the second for months:
 *
 *   1. MODEL MEMBERSHIP. A model can be absent from `ORG_SCOPED_MODELS` even
 *      though it HAS `organizationId`. Then EVERY operation on it is unscoped,
 *      not just findUnique — the handler's org ritual is irrelevant because the
 *      extension never fires. This is how `Order` leaked (see the entry below):
 *      the guards all checked the OPERATION (`findUnique` vs `findFirst`) and
 *      nothing checked the MODEL. `tenant-scope-coverage.test.ts` now does.
 *   2. OPERATION COVERAGE. On a model that IS listed, `findUnique`,
 *      `findUniqueOrThrow` and `updateManyAndReturn` are not scoped.
 *
 * So "the query used findFirst and the route called enterWithOrg" is NOT
 * sufficient evidence of isolation. Check the model is in the set.
 */
import { Prisma } from '@prisma/client'
import { AsyncLocalStorage } from 'async_hooks'

const orgStorage = new AsyncLocalStorage<string>()

export function getOrgContext(): string | undefined {
  return orgStorage.getStore()
}

export function enterWithOrg(orgId: string): void {
  orgStorage.enterWith(orgId)
}

export async function bypassOrg<T>(fn: () => Promise<T>): Promise<T> {
  return orgStorage.run(undefined as unknown as string, fn)
}

// ponytail: org-scoped models — every model that has organizationId, MINUS the
// explicit exceptions listed in ORG_SCOPE_EXCEPTIONS below.
//
// THE TWO EXCLUSIONS ARE DIFFERENT FACTS AND MUST NOT BE CONFLATED:
//   - `Organization` is not scoped because it IS the org root: it has no
//     `organizationId` column to inject.
//   - `Invitation` HAS `organizationId` and is deliberately unscoped, because
//     accepting an invitation is pre-auth — the token IS the credential and
//     there is no org context to inject yet. See ORG_SCOPE_EXCEPTIONS.
//
// This list is no longer maintained by hand. `tenant-scope-coverage.test.ts`
// parses prisma/schema.prisma, derives the set of models carrying
// `organizationId`, and fails if any of them is missing here. Add a model to the
// schema without adding it here and that test fails NAMING the model.
//
// Exported as a `ReadonlySet` so the guard compares against THE set the extension
// actually consults, rather than a second hand-written copy that could drift —
// a duplicate list is the artifact whose failure is being fixed here. Read-only
// because nothing outside this module should be able to widen or narrow scope.
export const ORG_SCOPED_MODELS: ReadonlySet<string> = new Set([
  'user',
  'integration',
  'integrationSchema',
  'llmConfig',
  'document',
  'documentChunk',
  'kgRelation',
  'vectorStoreConfig',
  'chatSession',
  'chatMessage',
  'appConfig',
  'restApiConnector',
  'restApiEndpoint',
  'restApiRequestLog',
  'toolRun',
  'apiKey',
  'apiRequestLog',
  'auditLog',
  'queryHistory',
  'plugin',
  'mcpServer',
  'scheduledRun',
  'scheduledRunLog',
  'notificationConfig',
  'agentRun',
  'llmUsageLog',
  'documentVersion',
  'savedPrompt',
  // WHY 'order' IS HERE AND WAS NOT BEFORE: `Order` has carried `organizationId`
  // since the model was added (2026-09), but it was omitted from this set when it
  // was created — and nothing caught the omission, because the only guard was a
  // hand-maintained list checked per-model, never against the schema.
  //
  // The omission was a LIVE cross-tenant IDOR, not a theoretical one. Measured by
  // driving the real handler and reading the SQL Prisma emitted:
  //     Document.findFirst -> WHERE (id = $1 AND organizationId = $2)   <- scoped
  //     Order.findFirst    -> WHERE  id = $1                            <- NOT scoped
  // `GET /api/billing/orders/[id]` (client-supplied order id) returned another
  // org's `status`, `months`, `amountIdr` and `licenseIssued` for any order id in
  // the install. Its docstring claimed the extension scoped the read, which is
  // exactly why nobody re-checked it — the false claim is fixed in that file too.
  'order',
])

/**
 * Models that carry `organizationId` but are DELIBERATELY not org-scoped.
 *
 * Exported so `tenant-scope-coverage.test.ts` can compare the schema against
 * `ORG_SCOPED_MODELS ∪ ORG_SCOPE_EXCEPTIONS` instead of against a second
 * hand-written copy of this list — a duplicated list would drift exactly like the
 * one that let `Order` through.
 *
 * Every entry MUST state its reason. An entry here is a place isolation does not
 * happen automatically, so adding one is a security decision, not a formality.
 */
export const ORG_SCOPE_EXCEPTIONS: Readonly<Record<string, string>> = {
  invitation: 'pre-auth: accepting an invite has no org context yet — the token IS the credential, and the invite route supplies organizationId explicitly in its compound unique key',
}

// Operations that accept a where clause for filtering (non-unique)
const FILTER_OPS = new Set([
  'findFirst', 'findFirstOrThrow', 'findMany', 'count', 'aggregate', 'groupBy',
])

// Operations that mutate via where clause
const MUTATE_WHERE_OPS = new Set([
  'update', 'updateMany', 'delete', 'deleteMany',
])

// Operations that create data
const CREATE_OPS = new Set([
  'create', 'createMany', 'createManyAndReturn',
])

function injectOrgWhere(args: any, orgId: string): any {
  if (!args.where) {
    args.where = { organizationId: orgId }
  } else if (args.where.organizationId === undefined) {
    args.where = { ...args.where, organizationId: orgId }
  }
  return args
}

function injectOrgCreate(args: any, orgId: string): any {
  if (!args.data) return args
  if (Array.isArray(args.data)) {
    args.data = args.data.map((d: any) =>
      d.organizationId === undefined ? { ...d, organizationId: orgId } : d,
    )
  } else {
    if (args.data.organizationId === undefined) {
      args.data = { ...args.data, organizationId: orgId }
    }
  }
  return args
}

export function createTenantExtension() {
  return Prisma.defineExtension({
    name: 'tenant',
    query: {
      async $allOperations({ args, query, model, operation }) {
        const orgId = orgStorage.getStore()
        // ponytail: Prisma passes model names in schema case (PascalCase, e.g. "User").
        // ORG_SCOPED_MODELS is keyed by first-lowercase names ("user") — normalize
        // before matching, otherwise injection silently never fires (cross-org leak).
        const modelKey = model ? model.charAt(0).toLowerCase() + model.slice(1) : undefined
        if (!orgId || !model || !modelKey || !ORG_SCOPED_MODELS.has(modelKey)) {
          return query(args)
        }

        if (FILTER_OPS.has(operation)) {
          args = injectOrgWhere(args, orgId)
        } else if (CREATE_OPS.has(operation)) {
          args = injectOrgCreate(args, orgId)
        } else if (MUTATE_WHERE_OPS.has(operation)) {
          // Inject orgId into where to prevent cross-tenant mutations
          args = injectOrgWhere(args, orgId)
        } else if (operation === 'upsert') {
          // ponytail: upsert where must be unique — don't inject into where.
          // Only inject into create data. If the record exists in another org,
          // the update path runs (potential cross-tenant issue) but in practice
          // upserts are only used in seed scripts with bypassOrg().
          if (args.create?.organizationId === undefined) {
            args.create = { ...args.create, organizationId: orgId }
          }
        }
        // findUnique/findUniqueOrThrow: skipped (see file-level comment)

        return query(args)
      },
    },
  })
}
