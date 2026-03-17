import { describe, expect, it } from "vitest";
import { buildDashboardView } from "../src/state";

describe("buildDashboardView", () => {
  it("summarizes counts and rows", () => {
    const view = buildDashboardView([
      {
        job: {
          id: 1,
          fingerprint: "abc",
          portal: "greenhouse",
          sourceUrl: "https://example.com",
          applyUrl: "https://example.com/job",
          company: "n8n",
          title: "Staff LLM Interaction Engineer",
          location: "Remote",
          rawJson: "{}",
          normalizedJson: "{}",
          status: "rejected",
          visitCount: 1,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        },
        evaluation: {
          archetypeId: "ai-platform-llmops",
          archetypeLabel: "AI Platform / LLMOps Engineer",
          summary: "Strong fit",
          scores: {
            roleFit: { score: 4.5, reasoning: "x" },
            skillsAlignment: { score: 4.4, reasoning: "x" },
            seniorityCalibration: { score: 4.1, reasoning: "x" },
            compensationRange: { score: 4.0, reasoning: "x" },
            geographicViability: { score: 4.5, reasoning: "x" },
            companyStability: { score: 3.6, reasoning: "x" },
            productMarketInterest: { score: 4.6, reasoning: "x" },
            growthTrajectory: { score: 4.2, reasoning: "x" },
            atsCompatibility: { score: 4.0, reasoning: "x" },
            timelineUrgency: { score: 3.8, reasoning: "x" }
          },
          totalScore: 4.2,
          recommendedAction: "apply",
          rejectionReasons: [],
          matchedKeywords: ["Playwright"],
          missingKeywords: [],
          generatedAt: new Date().toISOString()
        },
        resume: null,
        application: null
      }
    ]);

    expect(view.tabs[0].count).toBe(1);
    expect(view.tableRows[0][1]).toBe("n8n");
    expect(view.detailLines[0]).toContain("Archetype");
  });
});
