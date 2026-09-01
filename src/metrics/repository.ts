import type { Pool } from "pg";

interface CountRow {
  readonly state: string;
  readonly count: string;
}

interface DecisionRow {
  readonly requested_mode: string;
  readonly effective_mode: string;
  readonly requested_calls: number;
  readonly approved_calls: number;
  readonly verdict: string;
  readonly reasons: readonly string[];
  readonly created_at: Date;
}

interface PredictionQualityRow {
  readonly sample_size: string;
  readonly predicted_answer_rate: number | null;
  readonly observed_answer_rate: number | null;
  readonly brier_score: number | null;
}

export interface CampaignMetrics {
  readonly campaignId: string;
  readonly agents: Readonly<Record<string, number>>;
  readonly calls: Readonly<Record<string, number>>;
  readonly borrowers: Readonly<Record<string, number>>;
  readonly recentSafetyDecisions: readonly DecisionRow[];
  readonly evaluation: {
    readonly prediction: {
      readonly sampleSize: number;
      readonly predictedAnswerRate: number | null;
      readonly observedAnswerRate: number | null;
      readonly calibrationErrorPercentagePoints: number | null;
      readonly brierScore: number | null;
    };
    readonly operations: {
      readonly abandonmentRate: number;
      readonly callCompletionRate: number;
      readonly borrowerCompletionRate: number;
      readonly currentAgentOccupancy: number;
    };
  };
}

export class MetricsRepository {
  constructor(private readonly pool: Pool) {}

  async campaign(campaignId: string): Promise<CampaignMetrics> {
    const [agents, calls, borrowers, decisions, predictionQuality] = await Promise.all([
      this.pool.query<CountRow>(
        "SELECT state, count(*)::text AS count FROM agents WHERE campaign_id = $1 GROUP BY state",
        [campaignId],
      ),
      this.pool.query<CountRow>(
        "SELECT state, count(*)::text AS count FROM calls WHERE campaign_id = $1 GROUP BY state",
        [campaignId],
      ),
      this.pool.query<CountRow>(
        "SELECT state, count(*)::text AS count FROM borrowers WHERE campaign_id = $1 GROUP BY state",
        [campaignId],
      ),
      this.pool.query<DecisionRow>(
        `SELECT requested_mode, effective_mode, requested_calls, approved_calls,
                verdict, reasons, created_at
         FROM safety_decisions
         WHERE campaign_id = $1
         ORDER BY created_at DESC
         LIMIT 10`,
        [campaignId],
      ),
      this.pool.query<PredictionQualityRow>(
        `WITH evaluated_calls AS (
           SELECT
             (decision.snapshot ->> 'answerRateMean')::double precision AS predicted,
             CASE
               WHEN dial_call.answered_at IS NOT NULL
                 OR dial_call.state IN ('COMPLETED', 'ABANDONED') THEN 1.0
               ELSE 0.0
             END AS observed
           FROM calls AS dial_call
           JOIN dial_permits AS permit ON permit.id = dial_call.permit_id
           JOIN safety_decisions AS decision ON decision.id = permit.decision_id
           WHERE dial_call.campaign_id = $1
             AND dial_call.mode = 'PREDICTIVE'
             AND dial_call.state IN ('COMPLETED', 'FAILED', 'CANCELLED', 'ABANDONED')
             AND decision.snapshot ? 'answerRateMean'
         )
         SELECT
           count(*)::text AS sample_size,
           avg(predicted)::double precision AS predicted_answer_rate,
           avg(observed)::double precision AS observed_answer_rate,
           avg(power(predicted - observed, 2))::double precision AS brier_score
         FROM evaluated_calls`,
        [campaignId],
      ),
    ]);
    const agentCounts = counts(agents.rows);
    const callCounts = counts(calls.rows);
    const borrowerCounts = counts(borrowers.rows);
    const prediction = predictionQuality.rows[0];
    const predictedAnswerRate = prediction?.predicted_answer_rate ?? null;
    const observedAnswerRate = prediction?.observed_answer_rate ?? null;
    const abandonedCalls = value(callCounts, "ABANDONED");
    const completedCalls = value(callCounts, "COMPLETED");
    const terminalCalls = completedCalls
      + value(callCounts, "FAILED")
      + value(callCounts, "CANCELLED")
      + abandonedCalls;
    const answeredOutcomes = completedCalls + abandonedCalls;
    const totalBorrowers = total(borrowerCounts);
    const totalAgents = total(agentCounts);
    const occupiedAgents = value(agentCounts, "RESERVED")
      + value(agentCounts, "DIALING")
      + value(agentCounts, "CONNECTED");

    return {
      campaignId,
      agents: agentCounts,
      calls: callCounts,
      borrowers: borrowerCounts,
      recentSafetyDecisions: decisions.rows,
      evaluation: {
        prediction: {
          sampleSize: Number(prediction?.sample_size ?? 0),
          predictedAnswerRate,
          observedAnswerRate,
          calibrationErrorPercentagePoints:
            predictedAnswerRate === null || observedAnswerRate === null
              ? null
              : Math.abs(predictedAnswerRate - observedAnswerRate) * 100,
          brierScore: prediction?.brier_score ?? null,
        },
        operations: {
          abandonmentRate: ratio(abandonedCalls, answeredOutcomes),
          callCompletionRate: ratio(completedCalls, terminalCalls),
          borrowerCompletionRate: ratio(value(borrowerCounts, "COMPLETED"), totalBorrowers),
          currentAgentOccupancy: ratio(occupiedAgents, totalAgents),
        },
      },
    };
  }
}

function counts(rows: readonly CountRow[]): Readonly<Record<string, number>> {
  return Object.fromEntries(rows.map((row) => [row.state, Number(row.count)]));
}

function value(countsByState: Readonly<Record<string, number>>, state: string): number {
  return countsByState[state] ?? 0;
}

function total(countsByState: Readonly<Record<string, number>>): number {
  return Object.values(countsByState).reduce((sum, count) => sum + count, 0);
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}
