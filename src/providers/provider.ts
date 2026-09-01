import type { ProviderEvent } from "../domain/provider-event.js";

export interface PlaceCallCommand {
  readonly callId: string;
  readonly phoneNumber: string;
  readonly idempotencyKey: string;
}

export interface PlaceCallResult {
  readonly externalCallId: string;
  readonly acceptedAt: Date;
}

export interface ProviderCallStatus {
  readonly externalCallId: string;
  readonly state: "UNKNOWN" | "RINGING" | "ANSWERED" | "CONNECTED" | "COMPLETED" | "FAILED" | "CANCELLED";
}

export interface ProviderHealth {
  readonly healthy: boolean;
  readonly errorRate: number;
  readonly p95LatencyMs: number;
  readonly consecutiveFailures: number;
}

export type ProviderEventListener = (event: ProviderEvent) => void | Promise<void>;

export interface TelecomProvider {
  readonly name: string;
  placeCall(command: PlaceCallCommand): Promise<PlaceCallResult>;
  cancelCall(externalCallId: string, idempotencyKey: string): Promise<void>;
  getCallStatus(externalCallId: string): Promise<ProviderCallStatus>;
  health(): ProviderHealth;
  subscribe(listener: ProviderEventListener): () => void;
}
