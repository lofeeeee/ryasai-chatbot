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

**Turning the reranker off** (`RAG_LLM_RERANK=false`). Fastest of everything tried: median 7.7 s → 5.3 s. But the
question that mixes an answerable part with an unanswerable one ("how many days of leave, and what is the director's
salary?") was correct 2/8 with the reranker off against 7/8 with it on (run side by side, same minute).

The cause is NOT understood. The reranker runs after routing, so it should not change which tool is chosen, yet
the off-runs were routed to the database tool in 4 of 8 turns against 1 of 8 with it on. That is either chance at
a small sample or an interaction nobody has found. Until it is explained, switching the reranker off trades a real
accuracy risk for speed, and the saving is not worth an unexplained one.

**Skipping the rerank when the top score is high** and **skipping reflection when evidence looks strong.** Both need
a signal that separates "the evidence answers the question" from "it only looks like it does". The rerank score does
not: the compound question returned a top score of 10 while reflection correctly judged the evidence insufficient
(2 of 6 runs). A skip rule built on it would answer from half-evidence on exactly the questions where the
reflection step is doing its job. The near-miss questions (topic present, fact absent) scored 6 or lower, so a
threshold would work on them — which is the trap: it would pass the near-miss set and fail the compound one.

## Known and unchanged

- A compound question is correct only about half the time, before and after 1.7.0, because it is sometimes sent to
  the database tool instead of the documents.
- p95 is set by provider stalls of 30–60 s, which none of the above touches.
