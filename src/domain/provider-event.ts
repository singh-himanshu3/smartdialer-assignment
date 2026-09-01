import type { CallState } from "./call.js";

export const PROVIDER_EVENT_TYPES = [
  "INITIATED",
  "RINGING",
  "ANSWERED",
  "CONNECTED",
  "COMPLETED",
  "FAILED",
  "CANCELLED",
] as const;

export type ProviderEventType = (typeof PROVIDER_EVENT_TYPES)[number];

export const EVENT_TO_CALL_STATE: Readonly<Record<ProviderEventType, CallState>> = {
  INITIATED: "INITIATED",
  RINGING: "RINGING",
  ANSWERED: "ANSWERED",
  CONNECTED: "CONNECTED",
  COMPLETED: "COMPLETED",
  FAILED: "FAILED",
  CANCELLED: "CANCELLED",
};

export interface ProviderEvent {
  readonly provider: string;
  readonly eventId: string;
  readonly callId: string;
  readonly externalCallId: string;
  readonly type: ProviderEventType;
  readonly occurredAt: Date;
  readonly payload: Readonly<Record<string, unknown>>;
}
