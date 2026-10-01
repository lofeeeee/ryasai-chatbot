# Chat latency: what was measured, what shipped, what was rejected

Written for whoever next tries to make a document answer faster. Every number below was produced by
`benchmark/latency-eval.ts` on one development machine with one model (`deepseek-v4.1-flash`) — read them as
orders of magnitude, not as production figures.

## How to measure

```bash
EVAL_ORG_ID=<org> EVAL_USER_ID=<user> bun run benchmark/latency-eval.ts --label a --repeat 3 --out a.json
# change one thing, run again with --label b --out b.json
bun run benchmark/latency-eval.ts --compare a.json b.json     # exits 1 if any question's correct RATE fell
```

Each turn also reports its own breakdown: the `done` frame carries `timings`, and `/api/metrics` exposes
`chat_first_token_ms`, `chat_turn_total_ms` and `chat_pre_token_llm_calls`.

Use `--repeat`. One run of one question is one sample, and the provider stalls for 30–60 s often enough that a
single slow or wrong sample proves nothing in either direction.

## Where the wait goes

Before the first word of a document answer the pipeline made a chain of LLM calls, about 2 s each:
intent analysis → tool selection → rerank (once per query phrasing) → reflection → synthesis. Baseline: median 9.3 s
to first token, 6 LLM calls before it.

## Shipped in 1.7.0

| change | effect | price |
|---|---|---|
| tool selection starts alongside intent analysis (`SPECULATIVE_ROUTING`) | median 9.5 s → 7.4 s, paired run | one unneeded selector call on chat/clarification turns |
| rerank once over the merged pool, not once per phrasing | rerank calls 2.0 → 0.8 per turn | none measured |

Combined, on 15 questions x3: median 9.3 s → 7.6 s, 45/45 answers correct.

## Rejected, and why — do not re-open without new data

**Turning the reranker off** (`RAG_LLM_RERANK=false`). Fastest of everything tried: median 7.7 s -> 5.3 s, and every
question with a deterministic route stayed correct (45/45 originals, 3/3 and 3/3 on the two unanswerable ones).
The one question that changed was the compound one ("how many days of leave, and what is the director's salary?"):
correct 2/8 with the reranker off against 7/8 with it on.

That gap is mostly NOT the reranker. The tool selector itself is unstable on that question at temperature 0 —
called directly, 12 times, with no retrieval involved: documents 8, database 4. Two variants of the same compound
shape gave 4/12 and 7/12 database. A single-part salary question went to the database 12/12 and a single-part
leave question to documents 10/12 (2 text-only). So that question's outcome is decided by a coin flip the
reranker never sees. Whether 6 of 8 off-runs landing on a wrong answer is chance depends on the true wrong-rate:
at 1/3 the chance of 6+ of 8 is 2%, at 0.4 it is 5%, at 0.5 it is 15%. The selector measurements (4/12 and 7/12)
span that range, so this is unlikely but not excluded, and eight runs cannot settle it.

The reason it is still not shipped is different, and it is a limit of the evidence rather than a finding: the local
corpus is too easy to show what the reranker is for. The chunk that holds the answer was already first after fusion
in 13 of 14 answerable questions, so "no regression with the reranker off" is what you would see whether or not it
helps on a larger corpus. Switching it off would be justified by a test that could have failed, and this one could
not. Until there is a corpus where the fused order is wrong often enough to matter, leave it on.

**Skipping the rerank when the top score is high** and **skipping reflection when evidence looks strong.** Both need
a signal that separates "the evidence answers the question" from "it only looks like it does". The rerank score does
not: the compound question returned a top score of 10 while reflection correctly judged the evidence insufficient
(2 of 6 runs). A skip rule built on it would answer from half-evidence on exactly the questions where the
reflection step is doing its job. The near-miss questions (topic present, fact absent) scored 6 or lower, so a
threshold would work on them — which is the trap: it would pass the near-miss set and fail the compound one.

## Shipped after 1.7.0: the timeout retry ladder

`fetchWithRetry` retried EVERY failure, including a TIMEOUT — which means the request had already sat open for the
whole budget (30 s) and then sat open for it again, up to four attempts. MEASURED: first-token p95 43.3 s -> 11.3 s
with timeouts attempted once, and correctness on the 15-question set went 52/54 -> 53/54 (the same question, a
half-answerable compound one, is flaky by nature — see below).

The retry change also explains three of twelve tool-selection calls returning `null` on that question: a `null`
decision falls back to the heuristic router, and the traces showed the cause was `LLM transport error: The
operation timed out.` rather than anything about the question.

A 5xx and a connection error still use the full ladder — they come back immediately and usually succeed on the next
try — and a caller-supplied signal (the two streaming paths pass their own 120 s budget) is never replaced.

## Known and unchanged

- A compound question is correct only about half the time, before and after 1.7.0, because the tool selector sends
  it to the database tool about a third of the time and to the documents the rest — measured on the selector alone,
  12 calls, same input, temperature 0. Nothing in the retrieval stages can change that; it needs a routing change,
  and the selector's prompt is deliberately minimal (see the measured rule-count table in `tool-selector.ts`), so
  any edit must be re-measured at N=40 per arm, not tried once.
- p95 is set by provider stalls of 30–60 s, which none of the above touches.
