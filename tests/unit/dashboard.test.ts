import { describe, expect, it } from "vitest";
import { loadDashboard } from "../../src/api/dashboard.js";

describe("dashboard", () => {
  it("contains live campaign controls without external assets", async () => {
    const html = await loadDashboard();

    expect(html).toContain("SmartDialer - Campaign dashboard");
    expect(html).toContain("id=\"mode-select\"");
    expect(html).toContain("value=\"PROGRESSIVE\"");
    expect(html).toContain("value=\"PREDICTIVE\"");
    expect(html).toContain("Prediction quality");
    expect(html).toContain("Brier score");
    expect(html).toContain("/snapshot");
    expect(html).not.toMatch(/https?:\/\/[^\"']+\.(?:css|js)/);
  });
});
