# SmartDialer

A safety-first functional prototype for progressive and predictive outbound dialing.

The project focuses on the difficult parts of the assignment: concurrent allocation, explainable pacing, an enforceable safety boundary, idempotent provider integration, crash recovery, and failure simulation. It intentionally uses a modular monolith and PostgreSQL instead of adding a broker, cache, or microservices without a demonstrated need.

## What is implemented

- Progressive pacing: one approved call per currently available agent.
- Predictive pacing: proposes calls from projected agent capacity and a recent answer-rate estimate.
- Safety Controller: approves, reduces, rejects, or falls back to progressive mode.
- Expiring dial permits: the provider path cannot bypass a recorded safety decision.
- PostgreSQL allocation with row locking and `SKIP LOCKED`.
- Per-campaign advisory lock so multiple schedulers cannot independently spend the same capacity.
- Transactional outbox with leased, retryable commands.
- Idempotent provider event inbox with terminal-state protection.
- Two mock providers with different latency and failure behaviour.
- Worker recovery for expired leases and permits.
- Deterministic scenarios A-D and a basic load test.
- A repeatable 30-seed safety evaluation with explicit pass/fail gates.
- Unit and PostgreSQL integration tests for the required failure cases.

## Architecture

```mermaid
flowchart LR
  API[API / Simulator] --> CR[Campaign Runner]
  CR --> PE{Pacing Engine}
  PE -->|DialProposal| SC[Safety Controller]
  SC -->|DialPermits| CA[Call Allocator]
  CA -->|transaction| DB[(PostgreSQL)]
  DB --> OW[Outbox Worker]
  OW --> PG[Provider Gateway]
  PG --> A[Mock Provider A]
  PG --> B[Mock Provider B]
  A --> EI[Event Inbox]
  B --> EI
  EI --> SM[Call / Agent State Machines]
  SM --> DB
```

The database is authoritative. A cache could be added later for read performance, but it would never decide agent ownership or dialing capacity.

See [Architecture](docs/architecture.md), [Agent State Machine](docs/agent-state-machine.md), [Call State Machine](docs/call-state-machine.md), and [Failure Scenarios](docs/failure-scenarios.md).

## Requirements

- Node.js 24 or newer
- pnpm 11 or newer
- Docker Desktop, or a local PostgreSQL 17+ instance

## Quick start

```bash
pnpm install
cp .env.example .env
pnpm db:up
pnpm db:migrate
pnpm db:seed
```

On Windows PowerShell, use `Copy-Item .env.example .env` instead of `cp` if needed.

Start the worker in one terminal:

```bash
pnpm worker
```

The worker reports provider health, schedules active campaigns, processes the outbox, handles mock provider events, and runs recovery.

Start the API in another terminal:

```bash
pnpm dev
```

Open the live control center:

```text
http://localhost:3000/
```

It refreshes every two seconds and shows campaign controls, the five-stage dial pipeline,
agent/borrower/call states, provider health, pacing inputs, and the latest Safety Controller
decisions. Progressive/predictive mode, provider selection, campaign pause/resume, and a
manual safe decision can all be demonstrated from the page.

The **Prediction quality** section evaluates completed predictive calls against the answer-rate
estimate stored with the Safety Controller decision that authorized each call. It reports the
predicted and observed answer rates, their calibration gap in percentage points, the Brier score
for probability quality, and the sample size. Lower forecast error and Brier score are better;
zero is perfect. Abandonment is reported separately because model calibration is not a substitute
for the compliance-critical safety outcome.

You can also verify the underlying API directly:

```bash
curl http://localhost:3000/health
curl http://localhost:3000/campaigns/00000000-0000-4000-8000-000000000001/metrics
```

The seed campaign starts in progressive mode. Switch it to predictive mode with:

```bash
curl -X PATCH http://localhost:3000/campaigns/00000000-0000-4000-8000-000000000001 \
  -H "content-type: application/json" \
  -d '{"pacingMode":"PREDICTIVE"}'
```

You can also force one campaign decision without waiting for the scheduler:

```bash
pnpm campaign:tick
```

## API

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/` | Live SmartDialer control center |
| `GET` | `/health` | Database-backed health check |
| `GET` | `/campaigns/:id` | Campaign status, pacing mode, and provider |
| `GET` | `/campaigns/:id/snapshot` | Inputs seen by the pacing and safety layers |
| `GET` | `/campaigns/:id/metrics` | Agent, call, borrower, and recent safety-decision metrics |
| `POST` | `/campaigns/:id/tick` | Run one campaign decision manually |
| `PATCH` | `/campaigns/:id` | Change status, pacing mode, or provider |
| `POST` | `/agents/:id/state` | Change an agent state through the state machine |
| `POST` | `/provider-events` | Ingest a normalized provider event |

## Simulations

Run the submission evaluation first:

```bash
pnpm evaluate
```

It compares progressive and predictive mode over 30 deterministic seeds per scenario and fails
if stable scenarios abandon an answered call, shock-scenario abandonment reaches 2%, low-answer
utilization fails to improve, or unsafe conditions do not trigger rejection/fallback. The checked-in
baseline and interpretation are in [Evaluation results](docs/evaluation.md).

Run every assignment scenario in predictive mode:

```bash
pnpm simulate
```

Run a specific scenario or progressive mode:

```bash
pnpm simulate -- --scenario D --mode predictive
pnpm simulate -- --scenario A --mode progressive
```

The output includes utilization, initiated/answered/connected calls, abandoned answers, provider failures, reductions, rejections, fallbacks, and sample decision explanations.

Run the basic 100/1,000/10,000-agent decision-engine load test:

```bash
pnpm loadtest
```

At 10,000 agents, the default 100-call safety batch limit becomes the first intentional bottleneck. This demonstrates why scaling requires revisiting capacity partitioning and rate limits rather than merely adding processes.

Run all database-independent submission checks together:

```bash
pnpm verify
```

### Resetting only the demo campaign

For a clean dashboard before recording or presenting, stop the API and worker, then run:

```bash
pnpm db:reset-demo -- --yes
```

This deliberately deletes and recreates only the fixed demo campaign, its calls, decisions,
agents, borrowers, provider events, and related outbox commands. It does not recreate the database
or affect other campaign IDs. Start the worker and API again afterward.

## Tests

Run the unit suite:

```bash
pnpm test
```

PostgreSQL integration tests are skipped unless `TEST_DATABASE_URL` is provided. They truncate their target database, so always use a dedicated test database.

Example using the Docker PostgreSQL container:

```bash
docker compose exec postgres createdb -U smartdialer smartdialer_test
DATABASE_URL=postgres://smartdialer:smartdialer@localhost:5433/smartdialer_test pnpm db:migrate
TEST_DATABASE_URL=postgres://smartdialer:smartdialer@localhost:5433/smartdialer_test pnpm test:integration
```

PowerShell environment-variable syntax is:

```powershell
$env:DATABASE_URL = "postgres://smartdialer:smartdialer@localhost:5433/smartdialer_test"
pnpm db:migrate
$env:TEST_DATABASE_URL = $env:DATABASE_URL
pnpm test:integration
```

The integration suite proves:

- Two workers cannot reserve the same agent.
- One dial permit cannot be consumed twice.
- A crashed outbox worker's lease can be recovered.
- Duplicate events have one effect.
- Terminal calls cannot regress because of late events.
- Predictive answers with no remaining agent are recorded as safety incidents.

## Important safety boundary

The predictive engine only returns a `DialProposal`. It has no provider dependency.

The Safety Controller independently validates the snapshot and writes a limited number of short-lived dial permits. Each call has a database foreign key to one permit, and each permit can be consumed only once. Multiple campaign schedulers are serialized with a PostgreSQL advisory lock, while outstanding unconsumed permits are counted as exposure.

Predictive dialing cannot provide a mathematical zero-abandonment guarantee when calls are allowed to outnumber available agents. The implementation therefore makes the control path deterministic while bounding answer risk conservatively, preserving headroom, and falling back to progressive behaviour when inputs are stale or unsafe.

The default controller reserves 15% of projected agent capacity. Its one-in-a-million risk budget
is per decision tick, not a claim of end-to-end campaign probability; the smaller value accounts for
the fact that a campaign makes hundreds of decisions. These defaults are backed by the deterministic
evaluation rather than presented as universal production constants.

## Build

```bash
pnpm typecheck
pnpm build
```

The compiled API entry point is `dist/api/server.js`.

## Documentation

- [Architecture and data flow](docs/architecture.md)
- [Agent state machine](docs/agent-state-machine.md)
- [Call state machine](docs/call-state-machine.md)
- [Failure scenarios](docs/failure-scenarios.md)
- [Evaluation results](docs/evaluation.md)
- [Assignment requirement traceability](docs/requirements-traceability.md)
- [Demo and interview walkthrough](docs/demo.md)
- [Submission checklist](docs/submission-checklist.md)
- [ADR 0001: Modular monolith and PostgreSQL](docs/decisions/0001-modular-monolith-postgres.md)
- [ADR 0002: Enforced safety permits](docs/decisions/0002-enforced-safety-permits.md)
- [Final assignment question](docs/final-answer.md)
