export const CALL_STATES = [
  "QUEUED",
  "RESERVED",
  "INITIATED",
  "RINGING",
  "ANSWERED",
  "CONNECTED",
  "COMPLETED",
  "FAILED",
  "CANCELLED",
  "ABANDONED",
] as const;

export type CallState = (typeof CALL_STATES)[number];

export const TERMINAL_CALL_STATES: ReadonlySet<CallState> = new Set([
  "COMPLETED",
  "FAILED",
  "CANCELLED",
  "ABANDONED",
]);

const CALL_TRANSITIONS: Readonly<Record<CallState, ReadonlySet<CallState>>> = {
  QUEUED: new Set(["RESERVED", "CANCELLED", "FAILED"]),
  RESERVED: new Set(["INITIATED", "RINGING", "ANSWERED", "CONNECTED", "COMPLETED", "CANCELLED", "FAILED"]),
  INITIATED: new Set(["RINGING", "ANSWERED", "CONNECTED", "COMPLETED", "FAILED", "CANCELLED"]),
  RINGING: new Set(["ANSWERED", "CONNECTED", "COMPLETED", "FAILED", "CANCELLED"]),
  ANSWERED: new Set(["CONNECTED", "COMPLETED", "FAILED", "CANCELLED", "ABANDONED"]),
  CONNECTED: new Set(["COMPLETED", "FAILED", "CANCELLED"]),
  COMPLETED: new Set(),
  FAILED: new Set(),
  CANCELLED: new Set(),
  ABANDONED: new Set(),
};

export function isTerminalCallState(state: CallState): boolean {
  return TERMINAL_CALL_STATES.has(state);
}

export function canTransitionCall(from: CallState, to: CallState): boolean {
  return from === to || CALL_TRANSITIONS[from].has(to);
}

export function assertCallTransition(from: CallState, to: CallState): void {
  if (!canTransitionCall(from, to)) {
    throw new Error(`Invalid call transition: ${from} -> ${to}`);
  }
}
