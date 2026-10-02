# ADR 0012: Rate Limiting — In-Memory First, Then Redis

**Status:** Accepted  
**Date:** 2026-10-02

## Context

Middleware rate limiting has been in-memory since it was written: a per-instance `Map` of buckets in
`src/middleware.ts`, keyed per API key / session cookie / client IP and route, swept for expired
entries. The ceiling was documented next to the map — the limiter is **per-instance and not
distributed, so N instances means N × the configured limit**.

Two deliberate scope decisions in that same file are worth restating, because they are easy to
"fix" back into defects:

- `GET` is not limited. Read-only queries get no security benefit from throttling, and limiting
  them breaks normal UI navigation.
- `/api/auth/login` is not limited *here*. A per-request counter keyed on a session cookie a login
  request cannot have collapsed every anonymous caller into one bucket, so the eleventh person to
  sign in inside a minute was refused. Login's brute-force guard counts *failures*, inside the
  route.

Meanwhile the Redis side already had the right primitive. `rateLimit()` in `src/lib/redis.ts` is an
`INCR`-based counter with an `EXPIRE` on the first hit of a bucket, keyed per minute window, and it
returns `null` when Redis is unreachable — a deliberate null rather than an exception, so each
caller decides its own fallback rather than inheriting one. Two routes already used it inside their
handlers (`/api/v1/chat/completions`, `/api/v1/agent/run`), where the per-key limit comes from the
key's own `requestLimitPerMinute`.

The expensive endpoints are the three that trigger an LLM call and therefore spend the customer's
own provider credits: **chat completions, agent run, and agent dashboard**. On those, a limit that
is N × the configured value is not a number an operator can reason about — and a rate limit nobody
can reason about is indistinguishable from none.

One boundary worth drawing explicitly, because it is easy to over-read this ADR as covering:
Redis-backed limiting here bounds *request rate*, not token spend. Token budgeting is a separate,
deliberately dormant operator valve (`LLM_DAILY_TOKEN_BUDGET`, off unless set) that exists to stop
a runaway agent loop; it is not a billing mechanism, and it is not what this decision is about.

## Decision

The three expensive LLM endpoints — chat completions, agent run, agent dashboard — consult a Redis
`INCR`-based limiter first, so the count is shared across instances. The in-memory bucket in
middleware remains as the fallback when Redis is unreachable.

**On a Redis outage the limiter fails open to the in-memory limit — availability over strictness.**
This is a judgement, recorded here rather than left implicit:

- the in-memory limit still bounds a *single instance*, and a single app container per host is the
  documented deployment shape (see ADR 0009 for the same single-instance constraint arriving at a
  different decision);
- failing closed would turn an optional dependency into a hard one for a mechanism whose purpose is
  cost bounding, not access control — a Redis blip would then silence the chat product to protect
  against a scenario the default install cannot produce;
- the residual exposure during an outage is that an install running several app replicas briefly
  allows replica-count × the limit. That is the pre-existing documented ceiling returning, not a
  new one.

## Consequences

- **Positive:** the per-caller limit on the expensive endpoints is the same number regardless of how
  many app replicas run, because Redis holds one counter per key per minute window.
- **Positive:** a Redis outage degrades to the previous behaviour instead of a refusal. Chat keeps
  working and each instance still enforces its own bucket; the fail-open path is shared with the
  existing `rateLimit() => null` contract, so no route invents its own.
- **Positive:** the in-memory bucket remains the limiter for every route Redis does not cover, so
  the middleware's map is load-bearing rather than dead code.
- **Negative:** during a Redis outage the effective limit is again instance-count × the configured
  limit. The documented ceiling returns until Redis does. This is the accepted trade and must stay
  stated wherever the limiter is described.
- **Negative:** the shared counter's window is a fixed minute bucket keyed on the current time, not
  a sliding window, so a caller straddling a bucket boundary can spend up to 2 × the limit in a
  short burst. Acceptable when bounding LLM spend, worth knowing before anyone tightens it.
- **Negative:** Redis becomes a dependency for *correctness of the limit* even though it is not one
  for availability. The app's health reporting already treats Redis as an optional dependency that
  is *reported* in `degraded` without failing the container, so an install can sit in the fail-open
  state with nothing red — an operator who relies on a per-minute cap must expect it to be advisory
  while Redis is down.

## Alternatives

- **Fail closed on Redis outage:** rejected — it converts an optional dependency into a hard one for
  cost bounding, while the in-memory floor already covers the documented single-instance shape.
- **In-memory only (status quo):** rejected — it is what this replaces; the configured limit is not
  the enforced limit the moment a second replica exists.
- **A dedicated limiter service (token-bucket sidecar):** rejected — a new component in every
  on-prem install to solve a problem the Redis instance already present solves.
- **Sliding-window log in Redis:** deferred — more precise at the bucket edge, at the cost of more
  round trips per request; the burst bound above is acceptable for this purpose.
- **Limiting at the reverse proxy instead:** rejected — the limiter is keyed on API key and session
  identity the proxy cannot see, and the per-key limit differs per key (`requestLimitPerMinute`),
  which a single global proxy rule cannot express.
