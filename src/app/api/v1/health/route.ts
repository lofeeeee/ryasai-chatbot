import { NextResponse } from 'next/server'
import { publicConfig } from '@/lib/public-config'

/**
 * GET /api/v1/health — the LIVENESS probe. Deliberately touches NOTHING.
 *
 * DECISION (made against a measured production defect, see the "why" below):
 * the container healthcheck probes /api/health, NOT this route. This route stays
 * dependency-free.
 *
 * THE DEFECT THIS DECISION ANSWERS. The compose healthcheck used to probe THIS
 * route and decide on `r.ok`. It touches no dependency, so it was always true:
 * with Postgres DEAD the container still reported `healthy` and no orchestrator
 * ever restarted it — silent-failure class #14, a dead mechanism reporting
 * itself healthy. Two ways out existed:
 *
 *   (a) add a cheap real dependency check here, or
 *   (b) point the healthcheck at the deep endpoint and keep liveness separate.
 *
 * (b) was chosen, for four reasons:
 *
 *   1. TWO OPPOSITE QUESTIONS. Liveness asks "is this process wedged?" — the
 *      answer must come from the process itself, and a process that answers one
 *      HTTP request correctly is NOT wedged, whatever its database is doing.
 *      Readiness asks "should traffic / a restart go here?" — that is a question
 *      about dependencies. A liveness probe that fails because POSTGRES is down
 *      asks an orchestrator to kill a process that is running perfectly (k8s
 *      behaviour: liveness failure → restart), which converts a database outage
 *      into a restart loop that fixes nothing.
 *   2. THIS ROUTE IS PUBLIC and is hit by the public site and by orchestrator
 *      liveness checks. It must stay fast, and it must not grow a payload that
 *      describes internal topology to anonymous callers. Dependency checks mean
 *      per-dependency error strings, latency figures and service names — exactly
 *      the disclosure its sibling sanitizes.
 *   3. A HEALTHCHECK THAT FAILS ON A TRANSIENT BLIP RESTART-LOOPS THE
 *      CONTAINER. Redis, the validator, the memory sidecar and the embedding
 *      service are ALL optional by design here (the app degrades without each).
 *      Gating liveness on them would restart a healthy container over a sidecar
 *      the product is built to survive.
 *   4. FAIL-CLOSED IS PRESERVED WHERE IT MATTERS. The restart path is not
 *      weakened by moving it: /api/health returns 503 when `db` — the one
 *      critical dependency — is unreachable, and that status is what the
 *      healthcheck now reads.
 *
 * The response stays the four documented keys, from `publicConfig`, with no
 * dependency touched. This is asserted by COUNTING calls into every seam
 * (src/app/api/v1/health/route.test.ts), and the compose wiring is asserted by
 * src/app/api/health/route.test.ts so the two cannot drift back apart.
 */
export async function GET() {
  return NextResponse.json({
    ok: true,
    service: 'ryasai',
    version: publicConfig.appVersion,
    time: new Date().toISOString(),
  })
}
