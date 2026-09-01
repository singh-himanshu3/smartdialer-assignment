# Submission Checklist

## Automated evidence

- Run `pnpm verify` and save the terminal output.
- Run the PostgreSQL integration suite against the dedicated `smartdialer_test` database.
- Confirm all 19 unit/simulation tests and all 7 integration tests pass.
- Confirm all four `pnpm evaluate` acceptance checks pass.
- Confirm the 100, 1,000, and 10,000-agent load-test rows complete.

## Five-minute demo

- Optionally stop both processes and run `pnpm db:reset-demo -- --yes` for a clean history.
- Start `pnpm worker` and `pnpm dev` in separate terminals.
- Open `http://localhost:3000/` and show that health is live.
- Explain progressive mode, then switch to predictive mode.
- Point to proposal, Safety Controller decision, permits, allocation, and provider outcome.
- Show forecast calibration and abandonment as separate measures.
- Pause the campaign or stop the worker and explain why stale telemetry rejects dialing.
- Run `pnpm evaluate` and connect the results to the safety trade-off.

## Repository hygiene

- Do not submit `.env`, `node_modules`, `dist`, temporary PostgreSQL data, or generated screenshots.
- Include `pnpm-lock.yaml`, migrations, tests, diagrams, ADRs, and this documentation.
- Review `git status` before creating the final commit or archive.
- Read the assignment's submission instructions one final time before sending.
