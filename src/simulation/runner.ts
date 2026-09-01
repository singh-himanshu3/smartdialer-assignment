import { PredictivePacingEngine } from "../pacing/predictive.js";
import { ProgressivePacingEngine } from "../pacing/progressive.js";
import type { CampaignSnapshot, PacingMode, SafetyVerdict } from "../pacing/types.js";
import { SafetyController, type SafetyControllerConfig } from "../safety/controller.js";
import { seededRandom } from "./random.js";
import type { SimulationScenario } from "./scenarios.js";

interface RingingCall {
  readonly mode: PacingMode;
  readonly willAnswer: boolean;
  readonly talkTimeSeconds: number;
  secondsUntilOutcome: number;
}

interface ConnectedCall {
  secondsRemaining: number;
}

export interface SimulationResult {
  readonly scenario: string;
  readonly mode: PacingMode;
  readonly durationSeconds: number;
  readonly averageAgentUtilization: number;
  readonly callsInitiated: number;
  readonly callsAnswered: number;
  readonly callsConnected: number;
  readonly callsCompleted: number;
  readonly callsAbandoned: number;
  readonly providerFailures: number;
  readonly peakRingingCalls: number;
  readonly safetyDecisions: Readonly<Record<SafetyVerdict, number>>;
  readonly firstDecisionExplanations: readonly string[];
}

export interface SimulationOptions {
  readonly mode: PacingMode;
  readonly seed?: number;
  readonly overrideAgents?: number;
  readonly safetyConfig?: SafetyControllerConfig;
}

export function runSimulation(
  scenario: SimulationScenario,
  options: SimulationOptions,
): SimulationResult {
  const random = seededRandom(options.seed ?? 42);
  const progressive = new ProgressivePacingEngine();
  const predictive = new PredictivePacingEngine();
  const safety = new SafetyController(options.safetyConfig);
  const ringing: RingingCall[] = [];
  const connected: ConnectedCall[] = [];
  const safetyDecisions: Record<SafetyVerdict, number> = {
    APPROVED: 0,
    REDUCED: 0,
    REJECTED: 0,
    FALLBACK_TO_PROGRESSIVE: 0,
  };
  const firstDecisionExplanations: string[] = [];
  const baseAgents = options.overrideAgents ?? scenario.initialAgents;
  let totalAttempts = 0;
  let totalAnswers = 0;
  let callsInitiated = 0;
  let callsConnected = 0;
  let callsCompleted = 0;
  let callsAbandoned = 0;
  let providerFailures = 0;
  let utilizationArea = 0;
  let peakRingingCalls = 0;
  let previousAgents = baseAgents;

  for (let second = 0; second < scenario.durationSeconds; second += 1) {
    const point = scenario.at(second);
    const totalAgents = Math.max(0, Math.floor(baseAgents * point.availableAgentRatio));
    const agentDropRatio = previousAgents === 0 ? 0 : Math.max(0, previousAgents - totalAgents) / previousAgents;
    previousAgents = totalAgents;

    for (let index = connected.length - 1; index >= 0; index -= 1) {
      const call = connected[index];
      if (call === undefined) continue;
      call.secondsRemaining -= 1;
      if (call.secondsRemaining <= 0) {
        connected.splice(index, 1);
        callsCompleted += 1;
      }
    }

    if (connected.length > totalAgents) {
      const disconnected = connected.length - totalAgents;
      connected.splice(0, disconnected);
      callsCompleted += disconnected;
    }

    for (let index = ringing.length - 1; index >= 0; index -= 1) {
      const call = ringing[index];
      if (call === undefined) continue;
      call.secondsUntilOutcome -= 1;
      if (call.secondsUntilOutcome > 0) continue;
      ringing.splice(index, 1);
      if (!call.willAnswer) continue;

      totalAnswers += 1;
      if (connected.length < totalAgents) {
        connected.push({ secondsRemaining: call.talkTimeSeconds });
        callsConnected += 1;
      } else {
        callsAbandoned += 1;
      }
    }

    const progressiveReservations = ringing.filter((call) => call.mode === "PROGRESSIVE").length;
    const availableAgents = Math.max(0, totalAgents - connected.length - progressiveReservations);
    const recentAttempts = totalAttempts;
    const answerRateMean = (totalAnswers + 2) / (recentAttempts + 10);
    const answerRateUpperBound = Math.min(
      1,
      answerRateMean + 1.96 * Math.sqrt((answerRateMean * (1 - answerRateMean)) / (recentAttempts + 10)),
    );
    const expectedAgentsFree = connected.filter(
      (call) => call.secondsRemaining <= Math.ceil(point.providerLatencyMs / 1_000) + 4,
    ).length;
    const snapshot: CampaignSnapshot = {
      campaignId: `simulation-${scenario.name}`,
      capturedAt: new Date(second * 1_000),
      telemetryAgeMs: 0,
      availableAgents,
      expectedAgentsFreeByAnswerHorizon: expectedAgentsFree,
      connectedCalls: connected.length,
      ringingCalls: ringing.length,
      outstandingDialPermits: 0,
      answeredWaitingCalls: 0,
      recentAttempts,
      answerRateMean,
      answerRateUpperBound,
      averageSetupTimeMs: point.providerLatencyMs + 4_000,
      averageTalkTimeMs: point.averageTalkTimeSeconds * 1_000,
      recentAgentDropRatio: agentDropRatio,
      provider: {
        healthy: !point.providerOutage,
        errorRate: point.providerFailureRate,
        p95LatencyMs: point.providerLatencyMs,
        consecutiveFailures: point.providerOutage ? 3 : 0,
      },
    };

    const requestedEngine = options.mode === "PREDICTIVE" ? predictive : progressive;
    const proposal = requestedEngine.propose(snapshot);
    const decision = safety.evaluate(snapshot, proposal);
    safetyDecisions[decision.verdict] += 1;
    if (firstDecisionExplanations.length < 5 && decision.approvedCalls > 0) {
      firstDecisionExplanations.push(
        `t=${second}s: ${proposal.explanation} Safety approved ${decision.approvedCalls}/${proposal.requestedCalls}.`,
      );
    }

    for (let index = 0; index < decision.approvedCalls; index += 1) {
      if (random() < point.providerFailureRate) {
        providerFailures += 1;
        continue;
      }
      const callMode = decision.effectiveMode;
      const setupSeconds = Math.max(1, Math.round(point.providerLatencyMs / 1_000) + 4);
      ringing.push({
        mode: callMode,
        willAnswer: random() < point.answerRate,
        talkTimeSeconds: Math.max(1, Math.round(point.averageTalkTimeSeconds * (0.7 + random() * 0.6))),
        secondsUntilOutcome: setupSeconds,
      });
      totalAttempts += 1;
      callsInitiated += 1;
    }

    peakRingingCalls = Math.max(peakRingingCalls, ringing.length);
    utilizationArea += totalAgents === 0 ? 0 : Math.min(1, connected.length / totalAgents);
  }

  return {
    scenario: scenario.name,
    mode: options.mode,
    durationSeconds: scenario.durationSeconds,
    averageAgentUtilization: utilizationArea / scenario.durationSeconds,
    callsInitiated,
    callsAnswered: totalAnswers,
    callsConnected,
    callsCompleted,
    callsAbandoned,
    providerFailures,
    peakRingingCalls,
    safetyDecisions,
    firstDecisionExplanations,
  };
}
