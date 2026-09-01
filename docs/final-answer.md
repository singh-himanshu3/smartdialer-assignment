# Final Assignment Question

I would separate optimization from authority. A predictive engine may estimate how many calls could improve utilization, but it can only produce an explainable proposal. A separate Safety Controller owns the right to dial. It recomputes capacity from strongly consistent agent state, includes calls and permits already in flight, uses conservative answer-rate bounds, reserves 15% headroom, and issues a finite number of short-lived dial permits. The provider path cannot operate without consuming one of those permits.

When telemetry is stale, provider health deteriorates, the answer model lacks evidence, or agent capacity drops suddenly, the controller reduces the batch, rejects it, or falls back to one-agent-per-call progressive behaviour.

This retains deterministic control over who may dial and how much approved exposure exists. It cannot make predictive over-dialing itself mathematically risk-free: if more calls are active than agents, every borrower could answer. That remaining probability must be explicit, measured, tightly bounded, and disabled whenever the safety assumptions stop holding.

The submitted defaults were selected with a repeatable 30-seed evaluation, not a single favourable
run. Across stable scenarios A-C the predictive controller produced no abandoned answers and improved
average utilization by 3.77, 2.23, and 0.95 percentage points. In scenario D—an abrupt 40% capacity
loss combined with provider degradation and outage—it kept abandonment to 1.00% and repeatedly
rejected or fell back from unsafe predictive decisions. These simulation results validate the control
logic, but production thresholds would still require shadow traffic, calibrated outcome data, and a
compliance-approved abandonment target.
