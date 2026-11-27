# Performance measurements

Measured 27 November 2026 with `apps/api/test/performance.int.test.ts` (run with `PERF=true`): through the API in
process (no network), one API process, PostgreSQL in Docker, on a developer laptop that was also doing other work,
with a few hundred synthetic policies. **This is not a load test of a deployed environment**, and the numbers will
differ on Azure.

| Target (specification section 14) | Measured | Result |
|---|---|---|
| Quote, 95% within 500 ms (up to 10 benefits, 6 travellers) | 6 travellers, **2 rated benefits**: median 138 ms, p95 246 ms, max 354 ms (100 quotes) | Met at this size; ten benefits not tested |
| Bind and issue, 95% within 1 s | median 279 ms, p95 448 ms, max 503 ms (30 binds) | Met |
| Documents available within 30 s | p95 520 ms, max 544 ms | Met |
| Search within 2 s (E11-F01-S01) | p95 61 ms here; under 2 s over 2,000 policies (workbench test) | Met at this size |
| Peak quotes: ten times the measured peak | 10 concurrent: **22 quotes a second**, none failed, but **p95 689 ms** (over the 500 ms target) | No peak is measured yet. One process on a laptop does not hold 500 ms at this concurrency |

## Not measured

Ten benefits on a quote; cover verification latency; premium export and eligibility feed volumes at production size
(the feed processor has its own tests); 99.95% availability; behaviour with production data volumes.

## Next

Load test a deployed staging environment with the real plans once the launch peak is sized, with several API replicas.
