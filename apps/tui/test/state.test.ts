import { describe, expect, it } from "vitest";
import { buildDashboardTableData, buildDashboardView } from "../src/state";

describe("buildDashboardView", () => {
  it("summarizes counts and rows", () => {
    const postedAt = "2026-03-17T12:00:00.000Z";
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
          postedAt,
          rawJson: "{}",
          normalizedJson: "{}",
          status: "evaluated",
          visitCount: 1,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        },
        evaluation: {
          archetypeId: "ai-platform-llmops",
          archetypeLabel: "AI Platform / LLMOps Engineer",
          grade: "B",
          summary: "Strong fit",
          executiveSummary: "This is a strong fit for the target profile.",
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
          strongestSignals: ["roleFit 4.5/5"],
          riskSignals: [],
          cvMatches: [
            {
              requirement: "Build agent workflows.",
              proofPoint: "Built agent workflows.",
              strength: "Strong",
              notes: "Direct evidence."
            }
          ],
          gaps: [],
          levelStrategy: {
            targetLevel: "Staff",
            positioning: "Sell direct fit.",
            rationale: "Role and profile align.",
            risks: []
          },
          compensationView: {
            summary: "Comp is aligned.",
            verdict: "Viable.",
            notes: []
          },
          personalization: {
            language: "English",
            format: "Letter",
            keywords: ["Playwright"],
            recommendedProjects: ["Career Ops"],
            summaryFocus: "automation and agent systems"
          },
          interviewView: {
            likelihood: 74,
            rationale: "High role fit.",
            talkingPoints: ["Agent systems"]
          },
          generatedAt: new Date().toISOString()
        },
        resume: null,
        application: null,
        research: null,
        contact: null
      }
    ]);

    expect(view.tabs[0].count).toBe(1);
    expect(view.tabs.map((tab) => tab.label)).toEqual([
      "All",
      "Evaluated",
      "Shortlist",
      "Applied",
      "Interview",
      "Top >=4",
      "Do not apply"
    ]);
    expect(view.tableRows[0][2]).toBe("n8n");
    expect(view.tableRows[0][4]).toBe("2026-03-17");
    expect(view.detailLines[0]).toContain("Archetype");
  });

  it("fits long company and title cells within the available width", () => {
    const tableData = buildDashboardTableData([
      [
        "0.0",
        "-",
        "Martin-Brower of Canada Co.",
        "Business Intelligence Analyst and Data Visualization Specialist",
        "2026-03-18",
        "Ready to apply",
        "$110,000-$125,000 CAD"
      ]
    ], 72);

    const columnWidths = tableData[0].map((_, index) => Math.max(...tableData.map((row) => row[index].length)));
    const renderedWidth = columnWidths.reduce((total, width) => total + width, 0) + tableData[0].length + 1;

    expect(renderedWidth).toBeLessThanOrEqual(72);
    expect(tableData[1][2]).toContain("...");
    expect(tableData[1][3]).toContain("...");
    expect(tableData[1][4]).toBe("2026-03-18");
    expect(tableData[1][5]).toContain("...");
    expect(tableData[1][6].length).toBeGreaterThan(0);
  });

  it("sorts rows by newest posted date", () => {
    const baseRecord = {
      evaluation: null,
      resume: null,
      application: null,
      research: null,
      contact: null
    };
    const view = buildDashboardView([
      {
        ...baseRecord,
        job: {
          id: 1,
          fingerprint: "old",
          portal: "greenhouse",
          sourceUrl: "https://example.com",
          applyUrl: "https://example.com/job-1",
          company: "Old Co",
          title: "Analyst",
          location: "Toronto",
          postedAt: "2026-02-01T00:00:00.000Z",
          rawJson: "{}",
          normalizedJson: "{}",
          status: "normalized",
          visitCount: 0,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        }
      },
      {
        ...baseRecord,
        job: {
          id: 2,
          fingerprint: "new",
          portal: "greenhouse",
          sourceUrl: "https://example.com",
          applyUrl: "https://example.com/job-2",
          company: "New Co",
          title: "Senior Analyst",
          location: "Toronto",
          postedAt: "2026-03-10T00:00:00.000Z",
          rawJson: "{}",
          normalizedJson: "{}",
          status: "normalized",
          visitCount: 0,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        }
      }
    ]);

    expect(view.tableRows[0][2]).toBe("New Co");
    expect(view.tableRows[1][2]).toBe("Old Co");
    expect(view.visibleJobIds[0]).toBe(2);
    expect(view.visibleJobIds[1]).toBe(1);
  });

  it("filters shortlisted tab to only shortlisted jobs", () => {
    const baseRecord = {
      evaluation: null,
      resume: null,
      application: null,
      research: null,
      contact: null
    };
    const view = buildDashboardView([
      {
        ...baseRecord,
        job: {
          id: 1,
          fingerprint: "shortlisted",
          portal: "greenhouse",
          sourceUrl: "https://example.com",
          applyUrl: "https://example.com/job-1",
          company: "Shortlisted Co",
          title: "Analyst",
          location: "Toronto",
          rawJson: "{}",
          normalizedJson: "{}",
          status: "shortlisted",
          visitCount: 0,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        }
      },
      {
        ...baseRecord,
        job: {
          id: 2,
          fingerprint: "evaluated",
          portal: "greenhouse",
          sourceUrl: "https://example.com",
          applyUrl: "https://example.com/job-2",
          company: "Evaluated Co",
          title: "Senior Analyst",
          location: "Toronto",
          rawJson: "{}",
          normalizedJson: "{}",
          status: "evaluated",
          visitCount: 0,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        }
      }
    ], 0, "shortlisted");

    expect(view.tableRows).toHaveLength(1);
    expect(view.tableRows[0][2]).toBe("Shortlisted Co");
    expect(view.visibleJobIds).toEqual([1]);
  });

  it("hides transitioned jobs from all and keeps them in status tabs", () => {
    const now = new Date().toISOString();
    const baseRecord = {
      resume: null,
      application: null,
      research: null,
      contact: null
    };
    const records = [
      {
        ...baseRecord,
        job: {
          id: 1,
          fingerprint: "rejected-1",
          portal: "greenhouse",
          sourceUrl: "https://example.com",
          applyUrl: "https://example.com/job-1",
          company: "Rejected Co",
          title: "Data Engineer",
          location: "Toronto",
          rawJson: "{}",
          normalizedJson: "{}",
          status: "rejected" as const,
          visitCount: 0,
          createdAt: now,
          updatedAt: now
        },
        evaluation: { totalScore: 4.9, grade: "A" } as any
      },
      {
        ...baseRecord,
        job: {
          id: 2,
          fingerprint: "shortlist-1",
          portal: "greenhouse",
          sourceUrl: "https://example.com",
          applyUrl: "https://example.com/job-2",
          company: "Shortlist Co",
          title: "Senior Data Analyst",
          location: "Toronto",
          rawJson: "{}",
          normalizedJson: "{}",
          status: "shortlisted" as const,
          visitCount: 0,
          createdAt: now,
          updatedAt: now
        },
        evaluation: { totalScore: 4.7, grade: "A" } as any
      },
      {
        ...baseRecord,
        job: {
          id: 3,
          fingerprint: "applied-1",
          portal: "greenhouse",
          sourceUrl: "https://example.com",
          applyUrl: "https://example.com/job-3",
          company: "Applied Co",
          title: "Data Scientist",
          location: "Toronto",
          rawJson: "{}",
          normalizedJson: "{}",
          status: "submitted" as const,
          visitCount: 0,
          createdAt: now,
          updatedAt: now
        },
        evaluation: { totalScore: 4.5, grade: "A" } as any
      },
      {
        ...baseRecord,
        job: {
          id: 4,
          fingerprint: "interview-1",
          portal: "greenhouse",
          sourceUrl: "https://example.com",
          applyUrl: "https://example.com/job-4",
          company: "Interview Co",
          title: "ML Engineer",
          location: "Toronto",
          rawJson: "{}",
          normalizedJson: "{}",
          status: "blocked" as const,
          visitCount: 0,
          createdAt: now,
          updatedAt: now
        },
        evaluation: { totalScore: 4.6, grade: "A" } as any
      },
      {
        ...baseRecord,
        job: {
          id: 5,
          fingerprint: "evaluated-1",
          portal: "greenhouse",
          sourceUrl: "https://example.com",
          applyUrl: "https://example.com/job-5",
          company: "Evaluated Co",
          title: "Analytics Engineer",
          location: "Toronto",
          rawJson: "{}",
          normalizedJson: "{}",
          status: "evaluated" as const,
          visitCount: 0,
          createdAt: now,
          updatedAt: now
        },
        evaluation: { totalScore: 4.4, grade: "B" } as any
      }
    ];

    const allView = buildDashboardView(records, 0, "all");
    expect(allView.visibleJobIds).toEqual([5]);
    expect(allView.tableRows).toHaveLength(1);
    expect(allView.tableRows[0][2]).toBe("Evaluated Co");
    expect(allView.tabs.find((tab) => tab.key === "all")?.count).toBe(1);
    expect(allView.tabs.find((tab) => tab.key === "no_apply")?.count).toBe(1);

    const shortlistedView = buildDashboardView(records, 0, "shortlisted");
    expect(shortlistedView.visibleJobIds).toEqual([2]);
    expect(shortlistedView.tableRows[0][2]).toBe("Shortlist Co");

    const appliedView = buildDashboardView(records, 0, "applied");
    expect(appliedView.visibleJobIds).toEqual([3]);
    expect(appliedView.tableRows[0][2]).toBe("Applied Co");

    const interviewView = buildDashboardView(records, 0, "interview");
    expect(interviewView.visibleJobIds).toEqual([4]);
    expect(interviewView.tableRows[0][2]).toBe("Interview Co");

    const topView = buildDashboardView(records, 0, "top");
    expect(topView.visibleJobIds).toEqual([2, 3, 4, 5]);
    expect(topView.tableRows).toHaveLength(4);
    expect(topView.tableRows[0][2]).toBe("Shortlist Co");

    const noApplyView = buildDashboardView(records, 0, "no_apply");
    expect(noApplyView.visibleJobIds).toEqual([1]);
    expect(noApplyView.tableRows).toHaveLength(1);
    expect(noApplyView.tableRows[0][2]).toBe("Rejected Co");
  });
});

