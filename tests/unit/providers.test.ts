import { describe, expect, it } from "vitest";
import { createProviderB } from "../../src/providers/mock-provider.js";

describe("mock telecom providers", () => {
  it("acts as an unhealthy circuit when an outage is injected", async () => {
    const provider = createProviderB(() => 0.5, (_delayMs, _task) => undefined);
    provider.setOutage(true);

    await expect(
      provider.placeCall({
        callId: "call-1",
        phoneNumber: "+15550000001",
        idempotencyKey: "idempotency-1",
      }),
    ).rejects.toThrow("rejected");
    expect(provider.health().healthy).toBe(false);
    expect(provider.health().consecutiveFailures).toBe(1);
  });

  it("returns the same external call for an idempotent retry", async () => {
    const provider = createProviderB(() => 0.5, (_delayMs, _task) => undefined);
    const command = {
      callId: "call-2",
      phoneNumber: "+15550000002",
      idempotencyKey: "idempotency-2",
    };

    const first = await provider.placeCall(command);
    const retry = await provider.placeCall(command);
    expect(retry.externalCallId).toBe(first.externalCallId);
  });
});
