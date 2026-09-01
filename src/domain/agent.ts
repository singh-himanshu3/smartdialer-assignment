export const AGENT_STATES = [
  "OFFLINE",
  "AVAILABLE",
  "RESERVED",
  "DIALING",
  "CONNECTED",
  "WRAP_UP",
  "PAUSED",
] as const;

export type AgentState = (typeof AGENT_STATES)[number];

const AGENT_TRANSITIONS: Readonly<Record<AgentState, ReadonlySet<AgentState>>> = {
  OFFLINE: new Set(["AVAILABLE"]),
  AVAILABLE: new Set(["RESERVED", "PAUSED", "OFFLINE"]),
  RESERVED: new Set(["DIALING", "CONNECTED", "AVAILABLE", "OFFLINE"]),
  DIALING: new Set(["CONNECTED", "AVAILABLE", "OFFLINE"]),
  CONNECTED: new Set(["WRAP_UP", "OFFLINE"]),
  WRAP_UP: new Set(["AVAILABLE", "PAUSED", "OFFLINE"]),
  PAUSED: new Set(["AVAILABLE", "OFFLINE"]),
};

export function canTransitionAgent(from: AgentState, to: AgentState): boolean {
  return from === to || AGENT_TRANSITIONS[from].has(to);
}

export function assertAgentTransition(from: AgentState, to: AgentState): void {
  if (!canTransitionAgent(from, to)) {
    throw new Error(`Invalid agent transition: ${from} -> ${to}`);
  }
}
