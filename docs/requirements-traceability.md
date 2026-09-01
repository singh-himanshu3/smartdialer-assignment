# Assignment Traceability

This map connects each requested assignment area to executable code, tests, or documentation.

| Assignment area | Implementation and evidence |
| --- | --- |
| Progressive dialer | `src/pacing/progressive.ts`; agent-bound allocation in `src/allocation/service.ts` |
| Predictive pacing | Explainable capacity/answer-rate proposal in `src/pacing/predictive.ts` |
| Independent Safety Controller | `src/safety/controller.ts`; enforced one-use permits in `src/safety/decision-store.ts` and migration constraints |
| Agent lifecycle | `src/domain/agent.ts` and `docs/agent-state-machine.md` |
| Call lifecycle | `src/domain/call.ts` and `docs/call-state-machine.md` |
| Two workers see one agent | `FOR UPDATE SKIP LOCKED`, partial unique active-agent index, and the integration concurrency test |
| Borrower concurrency | Locked priority selection, partial unique active-borrower index, and transactional reservation |
| Duplicate provider events | Unique provider/event ID plus the idempotency integration test |
| Out-of-order events | Monotonic state transitions and absorbing terminal states, covered by integration tests |
| Agent disappears during setup | Answer-time assigned-agent validation and reassignment/abandonment integration tests |
| Two different mock providers | `src/providers/mock-provider.ts`; provider B injects slower responses, failures, ambiguity, duplicates, and reordering |
| Worker crash | Transactional outbox, recoverable worker leases, stable idempotency keys, and recovery integration test |
| Provider outage | Provider health reporter, hard rejection/fallback, retries, and scenario D |
| Sudden 40% agent drop | Recent offline ratio, immediate progressive fallback, scenario D, and the multi-seed safety gate |
| Scenarios A-D | `src/simulation/scenarios.ts`; run with `pnpm simulate` |
| Utilization and safety evidence | 30-seed comparison and pass/fail gates via `pnpm evaluate` |
| 100/1,000/10,000 scale discussion | `pnpm loadtest` plus bottleneck analysis in `docs/architecture.md` |
| Architecture diagram and decision note | `docs/architecture.md` and both ADRs under `docs/decisions` |
| Short final answer | `docs/final-answer.md` |

The automated verification commands and presentation order are in `docs/submission-checklist.md`.
