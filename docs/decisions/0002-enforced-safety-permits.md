# ADR 0002: Enforce safety decisions with dial permits

## Status

Accepted

## Context

Keeping the predictive engine in a separate class is not enough. Another code path could still call a provider or allocate a borrower without passing through safety checks.

## Decision

The predictive and progressive engines emit proposals only. The Safety Controller records a decision and creates exactly one short-lived permit per approved call. The calls table requires a unique permit foreign key. The allocator conditionally consumes the permit before claiming resources and creating an outbox command.

The campaign runner also obtains a per-campaign advisory lock, and snapshots count outstanding permits as exposure.

## Consequences

Benefits:

- The predictive engine has no provider dependency.
- Approval counts are auditable and explainable.
- A permit cannot be reused.
- Worker crashes do not make approved capacity invisible.
- Multiple schedulers cannot independently over-approve the same campaign snapshot.

Costs:

- Additional writes and permit cleanup.
- Campaign decisions are serialized.
- Permits need a carefully selected expiry time.

At higher scale, permits could become capacity leases per campaign shard. The invariant remains the same: the provider path must possess safety authority before initiating a call.
