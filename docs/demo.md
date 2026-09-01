# Demo and Interview Walkthrough

## Suggested walkthrough

1. Open `http://localhost:3000/` and establish that the page is a live view of PostgreSQL-backed state, not a separate simulation.
2. Switch between progressive and predictive mode. Point out the proposal, effective mode, verdict, approved count, and recorded explanation.
3. Follow the five-stage pipeline on the page: campaign, pacing engine, Safety Controller, allocator, provider.
4. Open `src/pacing/predictive.ts` and explain the mean-based proposal.
5. Open `src/safety/controller.ts` and show that the proposal is independently clamped.
6. Show the permit foreign key and partial unique indexes in `migrations/001_initial.sql`.
7. Open `src/allocation/service.ts` and explain `FOR UPDATE SKIP LOCKED`.
8. Open `src/workers/outbox-worker.ts` and explain crash recovery and idempotency.
9. Open `src/workers/provider-event-service.ts` and explain duplicate/out-of-order handling.
10. Run the evaluation, scenario D, the load test, and the integration tests.

The dashboard is intentionally an observability and control layer only. It changes campaign
configuration through the public API; it cannot issue provider calls or create permits directly.

## Commands

```bash
pnpm evaluate
pnpm simulate -- --scenario D --mode predictive
pnpm loadtest
pnpm test
```

With a dedicated test database configured:

```bash
pnpm test:integration
```

## Likely interview questions

### Two workers reserve the same agent

Both may observe availability before allocation. Inside the transaction, one locks and updates the row. The other skips it. The partial unique active-call index remains a second defence.

### Database says AVAILABLE, cache says RESERVED

The database wins. Cache state never authorizes a call.

### ANSWERED, worker crashes, then COMPLETED arrives

Provider events are durable and processed transactionally. If ANSWERED committed, COMPLETED continues from it. If not, the provider can jump directly to COMPLETED. A late ANSWERED cannot reopen a terminal call.

### Predicted answer rate drops from 70% to 10%

Recent observations update the mean and upper bound. Existing in-flight exposure is counted. The Safety Controller reduces new permits, and unsafe provider/agent signals force progressive fallback or rejection.

### Why 17 calls rather than 10?

Read the stored safety decision: it contains the proposal count, answer-rate inputs, projected capacity, risk cap, approved count, and textual reasons.

### What breaks first at 100,000 agents?

The single-campaign advisory lock and hot PostgreSQL allocation queues. Partition by campaign/shard, grant bounded capacity leases, partition events, and introduce a broker only after outbox polling becomes the measured bottleneck.

### Least confident area

Calibration of the predictive risk bound against real provider and borrower behaviour. Production rollout should begin in shadow mode, compare forecasts with outcomes, and tighten thresholds before allowing predictive permits.

## Clean presentation reset

Stop the API and worker before resetting so no in-memory mock-provider events are still arriving:

```bash
pnpm db:reset-demo -- --yes
```

Then restart `pnpm worker` and `pnpm dev`. This reset is intentionally scoped to the fixed demo
campaign ID; never point it at a production database.
