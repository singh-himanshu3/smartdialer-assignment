# Evaluation Results

## Reproduce the result

```bash
pnpm evaluate
```

The command runs progressive and predictive mode with 30 deterministic random seeds for each
600-second scenario. It exits unsuccessfully if any acceptance gate fails, so it can also run in CI.

## Checked-in baseline

| Scenario | Progressive utilization | Predictive utilization | Lift | Predictive abandonment |
| --- | ---: | ---: | ---: | ---: |
| A: 20% answers, 120s talk | 81.35% | 85.13% | +3.77 pp | 0.00% |
| B: 50% answers, 90s talk | 89.35% | 91.58% | +2.23 pp | 0.00% |
| C: 70% answers, 180s talk | 95.56% | 96.51% | +0.95 pp | 0.00% |
| D: changing traffic, agent drop, provider outage | 81.56% | 83.97% | +2.41 pp | 1.00% |

The predictive runs abandoned zero answered calls across all 90 stable runs. Scenario D deliberately
removes 40% of agents while calls are already ringing. Those calls cannot be made safe retroactively;
the important behavior is that new predictive exposure falls back or stops and aggregate abandonment
stays below the 2% evaluation gate.

## Why these metrics are separate

- Utilization measures the optimization goal: the fraction of available agent-seconds spent connected.
- Abandonment measures the safety outcome: answered calls that had no agent.
- Forecast calibration compares predicted and observed answer rates on the live dashboard.
- Brier score measures probability quality for each completed predictive call; lower is better.

A well-calibrated model can still violate safety if its outputs are used without capacity controls.
Conversely, conservative safety can protect callers while sacrificing utilization. The evaluation
therefore reports both rather than calling one number “accuracy.”

## Scope and limitations

These are deterministic simulator results, not a production service-level claim. The simulator models
answer probability, talk time, provider failure/latency, an outage, and sudden agent loss. It does not
model every real correlation, carrier behavior, human response pattern, or regulatory rule. Production
release would start with shadow predictions, compare forecasts to observed outcomes by campaign and
time window, and only then enable tightly monitored predictive permits.
