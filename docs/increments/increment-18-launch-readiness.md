# Increment 18: Launch readiness

Design: [ADR 0023](../adr/0023-launch-readiness.md). Everything in the tests is **synthetic**.

| Story / requirement | Status | Evidence |
|---|---|---|
| E16-F01-S01 Every launch benefit and state passes parity and plan tests | **Not met: no launch-state forms or manuals have been supplied**. The report that shows what each state lacks is built | `launch.int.test.ts` |
| E16-F02-S01 At least two rehearsals per launch account | Not done: needs Assurant users and accounts | — |
| E16-F02-S01 Sign-off from product, actuarial, compliance and finance | Mechanism met; nothing is signed | Sign-offs by four people on the report as read |
| E16-F02-S02 A short guide and training session per role | Guides written; **sessions not held** | [guides](../guides/README.md), generated from roles and menu and checked in CI |
| E21-F06-S01 Card programme migration | **Not started**: the scope is not agreed and no extract from the current system exists | The eligibility feed and issuer mapping (Increment 16e) are the loading path |
| NFR latency and throughput | Partly measured | [performance](../operations/performance.md) |

## To confirm with Assurant

Launch states and their filed forms and manuals; the rehearsal plan; who signs for actuarial; migration scope and
data; the measured peak to size for.
