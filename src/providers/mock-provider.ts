import { randomUUID } from "node:crypto";
import type { ProviderEvent, ProviderEventType } from "../domain/provider-event.js";
import type {
  PlaceCallCommand,
  PlaceCallResult,
  ProviderCallStatus,
  ProviderEventListener,
  ProviderHealth,
  TelecomProvider,
} from "./provider.js";

export interface MockProviderProfile {
  readonly answerRate: number;
  readonly failureRate: number;
  readonly ambiguousTimeoutRate: number;
  readonly duplicateEventRate: number;
  readonly outOfOrderEventRate: number;
  readonly minimumLatencyMs: number;
  readonly maximumLatencyMs: number;
}

export type Scheduler = (delayMs: number, task: () => void) => void;

interface MockCall {
  readonly callId: string;
  readonly externalCallId: string;
  state: ProviderCallStatus["state"];
}

const immediateScheduler: Scheduler = (delayMs, task) => {
  setTimeout(task, delayMs);
};

export class MockTelecomProvider implements TelecomProvider {
  private readonly listeners = new Set<ProviderEventListener>();
  private readonly callsByIdempotencyKey = new Map<string, MockCall>();
  private readonly callsByExternalId = new Map<string, MockCall>();
  private outage = false;
  private attempts = 0;
  private failures = 0;
  private consecutiveFailures = 0;

  constructor(
    readonly name: string,
    private readonly profile: MockProviderProfile,
    private readonly random: () => number = Math.random,
    private readonly schedule: Scheduler = immediateScheduler,
  ) {}

  setOutage(outage: boolean): void {
    this.outage = outage;
  }

  async placeCall(command: PlaceCallCommand): Promise<PlaceCallResult> {
    this.attempts += 1;
    const existing = this.callsByIdempotencyKey.get(command.idempotencyKey);
    if (existing !== undefined) {
      return { externalCallId: existing.externalCallId, acceptedAt: new Date() };
    }

    if (this.outage || this.random() < this.profile.failureRate) {
      this.failures += 1;
      this.consecutiveFailures += 1;
      throw new Error(`${this.name} rejected the call request`);
    }

    const call: MockCall = {
      callId: command.callId,
      externalCallId: `${this.name}-${randomUUID()}`,
      state: "RINGING",
    };
    this.callsByIdempotencyKey.set(command.idempotencyKey, call);
    this.callsByExternalId.set(call.externalCallId, call);
    this.consecutiveFailures = 0;
    this.scheduleLifecycle(call);

    if (this.random() < this.profile.ambiguousTimeoutRate) {
      this.failures += 1;
      this.consecutiveFailures += 1;
      throw new Error(`${this.name} timed out after accepting the call`);
    }

    return { externalCallId: call.externalCallId, acceptedAt: new Date() };
  }

  async cancelCall(externalCallId: string, _idempotencyKey: string): Promise<void> {
    const call = this.callsByExternalId.get(externalCallId);
    if (call === undefined || isTerminalProviderState(call.state)) return;
    call.state = "CANCELLED";
    await this.emit(call, "CANCELLED");
  }

  async getCallStatus(externalCallId: string): Promise<ProviderCallStatus> {
    const call = this.callsByExternalId.get(externalCallId);
    return call === undefined
      ? { externalCallId, state: "UNKNOWN" }
      : { externalCallId, state: call.state };
  }

  health(): ProviderHealth {
    const errorRate = this.attempts === 0 ? 0 : this.failures / this.attempts;
    return {
      healthy: !this.outage && this.consecutiveFailures < 3,
      errorRate,
      p95LatencyMs: this.profile.maximumLatencyMs,
      consecutiveFailures: this.consecutiveFailures,
    };
  }

  subscribe(listener: ProviderEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private scheduleLifecycle(call: MockCall): void {
    const firstDelay = this.latency();
    const answered = this.random() < this.profile.answerRate;
    const outOfOrder = answered && this.random() < this.profile.outOfOrderEventRate;
    let lastIntermediateDelay = firstDelay;

    if (outOfOrder) {
      this.schedule(firstDelay, () => void this.progress(call, "ANSWERED"));
      lastIntermediateDelay = firstDelay + this.latency();
      this.schedule(lastIntermediateDelay, () => void this.progress(call, "RINGING"));
    } else {
      this.schedule(firstDelay, () => void this.progress(call, "RINGING"));
      if (answered) {
        lastIntermediateDelay = firstDelay + this.latency();
        this.schedule(lastIntermediateDelay, () => void this.progress(call, "ANSWERED"));
      }
    }

    const terminalDelay = lastIntermediateDelay + this.latency() * 3;
    this.schedule(terminalDelay, () =>
      void this.progress(call, answered ? "COMPLETED" : "FAILED"),
    );
  }

  private async progress(call: MockCall, type: ProviderEventType): Promise<void> {
    if (isTerminalProviderState(call.state)) return;
    call.state = providerState(type);
    await this.emit(call, type);
    if (this.random() < this.profile.duplicateEventRate) {
      await this.emit(call, type, true);
    }
  }

  private async emit(call: MockCall, type: ProviderEventType, duplicate = false): Promise<void> {
    const event: ProviderEvent = {
      provider: this.name,
      eventId: duplicate ? `${call.externalCallId}:${type}:original` : randomUUID(),
      callId: call.callId,
      externalCallId: call.externalCallId,
      type,
      occurredAt: new Date(),
      payload: { mock: true, duplicate },
    };
    if (!duplicate) {
      (call as MockCall & { lastEventId?: string }).lastEventId = event.eventId;
    } else {
      const lastEventId = (call as MockCall & { lastEventId?: string }).lastEventId;
      if (lastEventId !== undefined) {
        (event as { eventId: string }).eventId = lastEventId;
      }
    }
    await Promise.all([...this.listeners].map((listener) => listener(event)));
  }

  private latency(): number {
    const range = this.profile.maximumLatencyMs - this.profile.minimumLatencyMs;
    return Math.round(this.profile.minimumLatencyMs + this.random() * Math.max(0, range));
  }
}

export function createProviderA(random?: () => number, scheduler?: Scheduler): MockTelecomProvider {
  return new MockTelecomProvider(
    "provider-a",
    {
      answerRate: 0.35,
      failureRate: 0.01,
      ambiguousTimeoutRate: 0,
      duplicateEventRate: 0,
      outOfOrderEventRate: 0,
      minimumLatencyMs: 20,
      maximumLatencyMs: 80,
    },
    random,
    scheduler,
  );
}

export function createProviderB(random?: () => number, scheduler?: Scheduler): MockTelecomProvider {
  return new MockTelecomProvider(
    "provider-b",
    {
      answerRate: 0.45,
      failureRate: 0.08,
      ambiguousTimeoutRate: 0.05,
      duplicateEventRate: 0.25,
      outOfOrderEventRate: 0.2,
      minimumLatencyMs: 100,
      maximumLatencyMs: 900,
    },
    random,
    scheduler,
  );
}

function providerState(type: ProviderEventType): ProviderCallStatus["state"] {
  if (type === "INITIATED") return "RINGING";
  return type;
}

function isTerminalProviderState(state: ProviderCallStatus["state"]): boolean {
  return state === "COMPLETED" || state === "FAILED" || state === "CANCELLED";
}
