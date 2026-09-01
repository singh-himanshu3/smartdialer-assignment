import { describe, expect, it } from "vitest";
import { canTransitionAgent } from "../../src/domain/agent.js";
import { canTransitionCall, isTerminalCallState } from "../../src/domain/call.js";

describe("agent state machine", () => {
  it("allows the normal call lifecycle", () => {
    expect(canTransitionAgent("AVAILABLE", "RESERVED")).toBe(true);
    expect(canTransitionAgent("RESERVED", "DIALING")).toBe(true);
    expect(canTransitionAgent("DIALING", "CONNECTED")).toBe(true);
    expect(canTransitionAgent("CONNECTED", "WRAP_UP")).toBe(true);
    expect(canTransitionAgent("WRAP_UP", "AVAILABLE")).toBe(true);
  });

  it("does not allow two lifecycle stages to be skipped unsafely", () => {
    expect(canTransitionAgent("AVAILABLE", "CONNECTED")).toBe(false);
  });
});

describe("call state machine", () => {
  it("allows providers to skip intermediate delivery events", () => {
    expect(canTransitionCall("INITIATED", "ANSWERED")).toBe(true);
    expect(canTransitionCall("INITIATED", "COMPLETED")).toBe(true);
  });

  it("makes terminal states absorbing", () => {
    expect(isTerminalCallState("COMPLETED")).toBe(true);
    expect(canTransitionCall("COMPLETED", "ANSWERED")).toBe(false);
    expect(canTransitionCall("FAILED", "RINGING")).toBe(false);
  });
});
