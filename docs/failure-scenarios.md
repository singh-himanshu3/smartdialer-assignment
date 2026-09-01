# Failure Scenarios

## 1. Worker crash

Sequence:

```text
agent reserved -> borrower reserved -> call created -> outbox written -> commit
```

If the worker crashes before commit, none of those effects exist. If it crashes after commit, another worker claims the outbox command. If it crashes after provider acceptance but before the database update, the replacement retries with the same provider idempotency key.

An integration test simulates an expired `PROCESSING` lease, runs recovery, and proves a replacement worker completes the same command.

## 2. Provider outage

- Existing calls remain represented in PostgreSQL and can still receive late events.
- New commands are retried with exponential backoff and stable idempotency keys.
- When retries are exhausted, recovery marks the reserved call failed and releases its agent and borrower.
- Provider health is refreshed every second.
- Three consecutive failures, explicit unhealthy state, excessive errors, or excessive latency stop predictive pacing.
- Ambiguous calls are not failed over blindly to another provider.

Provider B can inject outright failures, ambiguous timeouts, duplicates, and out-of-order events.

## 3. Agent availability suddenly drops

The campaign snapshot measures recent transitions to `OFFLINE`. A drop of 20% or more forces progressive fallback. Scenario D removes 40% of capacity, increases provider failures, and later creates a full outage.

Already answered calls cannot be made safe retroactively. If an answer has no assignable agent, it becomes `ABANDONED`, increments `safety_incidents`, and is visible in metrics.

## 4. Duplicate provider events

The provider inbox uniqueness constraint gives every event one effect. Repeated events return `DUPLICATE`; they do not repeat agent or borrower transitions.

## 5. Out-of-order events

Terminal states cannot regress. A test applies `ANSWERED`, repeats it, applies `COMPLETED`, and then delivers late `RINGING`. The final call remains `COMPLETED`.

## 6. Multiple schedulers

Multiple workers may run the same campaign, but each campaign tick is protected by a PostgreSQL advisory lock. Short-lived unconsumed permits are counted as exposure, preventing another tick from spending capacity that a crashed or slow allocator already obtained.

## 7. Database/cache disagreement

The prototype has no correctness cache. PostgreSQL wins. A future cache may report stale availability temporarily, but final allocation and permit consumption always execute conditionally in the database.
