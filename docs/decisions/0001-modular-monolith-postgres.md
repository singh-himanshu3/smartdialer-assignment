# ADR 0001: Modular monolith with PostgreSQL coordination

## Status

Accepted

## Context

The prototype must demonstrate concurrency, idempotency, recovery, provider abstraction, predictive pacing, and safety in a short timebox. Kafka, Redis, and independently deployed services would increase operational surface area without removing the need for a transactional source of truth.

## Decision

Use one TypeScript codebase with API, worker, simulator, and CLI entry points. Use PostgreSQL for state, row locking, unique constraints, advisory locks, work leases, the event inbox, and the transactional outbox.

## Consequences

Benefits:

- One local setup and one migration path.
- Strong, inspectable concurrency guarantees.
- Multiple workers can run without a new coordination service.
- Failure tests exercise the same persistence model as production code.

Costs:

- PostgreSQL is a coordination bottleneck for hot campaigns.
- Polling the outbox creates avoidable database work at high volume.
- A large single campaign is serialized at the decision boundary.

If measurements justify it, campaign partitions and a broker-backed outbox consumer can be introduced later. The safety-capacity authority must remain strongly consistent.
