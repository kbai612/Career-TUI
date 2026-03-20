import type { JobRecordWithArtifacts } from "@career-ops/core";

export type TabKey = "all" | "evaluated" | "applied" | "interview" | "shortlisted" | "top" | "no_apply";
export type DetailViewKey = "summary" | "cv" | "gaps" | "research" | "contact";

export interface DashboardView {
  tabs: Array<{ key: TabKey; label: string; count: number }>;
  statusLine: string;
  tableRows: string[][];
  detailTitle: string;
  detailLines: string[];
  visibleJobIds: number[];
}

export const DASHBOARD_TABLE_HEADERS = ["Score", "Grade", "Company", "Title", "Posted", "Status", "Comp"] as const;

const TABLE_FLOOR_WIDTHS = DASHBOARD_TABLE_HEADERS.map((header) => header.length);
const TABLE_MIN_WIDTHS = [3, 3, 8, 16, 10, 12, 8];
const TABLE_IDEAL_WIDTHS = [3, 3, 12, 24, 10, 12, 12];
const TABLE_MAX_WIDTHS = [3, 3, 18, 38, 10, 14, 18];
const TABLE_GROWTH_ORDER = [3, 2, 6, 5];
const TABLE_SHRINK_ORDER = [6, 2, 3, 5, 4];
const TRUNCATION_MARKER = "...";

function sumWidths(widths: number[]): number {
  return widths.reduce((total, width) => total + width, 0);
}

function textWidth(value: string): number {
  return Array.from(value).length;
}

function takeText(value: string, width: number): string {
  return Array.from(value).slice(0, width).join("");
}

function truncateCell(value: string, width: number): string {
  if (textWidth(value) <= width) {
    return value;
  }
  if (width <= TRUNCATION_MARKER.length) {
    return takeText(value, width);
  }
  return `${takeText(value, width - TRUNCATION_MARKER.length)}${TRUNCATION_MARKER}`;
}

function growWidths(widths: number[], targets: number[], remaining: number, order: number[]): number {
  while (remaining > 0) {
    let changed = false;
    for (const index of order) {
      if (remaining === 0) {
        break;
      }
      if (widths[index] >= targets[index]) {
        continue;
      }
      widths[index] += 1;
      remaining -= 1;
      changed = true;
    }
    if (!changed) {
      break;
    }
  }
  return remaining;
}

function shrinkWidths(widths: number[], floors: number[], deficit: number, order: number[]): number {
  while (deficit > 0) {
    let changed = false;
    for (const index of order) {
      if (deficit === 0) {
        break;
      }
      if (widths[index] <= floors[index]) {
        continue;
      }
      widths[index] -= 1;
      deficit -= 1;
      changed = true;
    }
    if (!changed) {
      break;
    }
  }
  return deficit;
}

export function buildDashboardTableData(tableRows: string[][], totalWidth: number): string[][] {
  const rows = [
    [...DASHBOARD_TABLE_HEADERS],
    ...tableRows.map((row) => DASHBOARD_TABLE_HEADERS.map((_, index) => row[index] ?? ""))
  ];
  const availableWidth = Math.max(sumWidths(TABLE_FLOOR_WIDTHS), totalWidth - (DASHBOARD_TABLE_HEADERS.length + 1));
  const widths = TABLE_MIN_WIDTHS.map((width, index) => Math.max(TABLE_FLOOR_WIDTHS[index], width));
  const startingWidth = sumWidths(widths);

  if (startingWidth > availableWidth) {
    shrinkWidths(widths, TABLE_FLOOR_WIDTHS, startingWidth - availableWidth, TABLE_SHRINK_ORDER);
  } else {
    let remaining = availableWidth - startingWidth;
    remaining = growWidths(widths, TABLE_IDEAL_WIDTHS, remaining, TABLE_GROWTH_ORDER);
    const desiredWidths = DASHBOARD_TABLE_HEADERS.map((_, index) => {
      const contentWidth = rows.reduce((maxWidth, row) => Math.max(maxWidth, textWidth(row[index] ?? "")), TABLE_FLOOR_WIDTHS[index]);
      return Math.max(widths[index], Math.min(TABLE_MAX_WIDTHS[index], contentWidth));
    });
    growWidths(widths, desiredWidths, remaining, TABLE_GROWTH_ORDER);
  }

  return rows.map((row) => row.map((cell, index) => truncateCell(cell, widths[index])));
}

function formatCount(label: string, count: number): string {
  return `${label}: ${count}`;
}

function postedTimestamp(record: JobRecordWithArtifacts): number {
  if (!record.job.postedAt) {
    return Number.NEGATIVE_INFINITY;
  }
  const timestamp = Date.parse(record.job.postedAt);
  return Number.isFinite(timestamp) ? timestamp : Number.NEGATIVE_INFINITY;
}

function sortByNewestPosted(records: JobRecordWithArtifacts[]): JobRecordWithArtifacts[] {
  return [...records].sort((left, right) => {
    const postedDiff = postedTimestamp(right) - postedTimestamp(left);
    if (postedDiff !== 0) {
      return postedDiff;
    }
    return right.job.id - left.job.id;
  });
}

function formatPostedDate(postedAt: string | undefined): string {
  if (!postedAt) {
    return "-";
  }
  const date = new Date(postedAt);
  if (Number.isNaN(date.getTime())) {
    return "-";
  }
  return date.toISOString().slice(0, 10);
}

function buildDetailLines(record: JobRecordWithArtifacts | null, detailView: DetailViewKey): { title: string; lines: string[] } {
  if (record == null) {
    return { title: "Summary", lines: ["No jobs loaded."] };
  }

  const report = record.evaluation;
  const hasRichReport = report != null
    && Array.isArray((report as { cvMatches?: unknown[] }).cvMatches)
    && typeof (report as { executiveSummary?: string }).executiveSummary === "string";
  switch (detailView) {
    case "cv":
      return {
        title: "CV Match",
        lines: !hasRichReport
          ? ["No rich evaluation report yet. Run the offer report again to refresh this job."]
          : report.cvMatches.flatMap((match, index) => [
              `${index + 1}. [${match.strength}] ${match.requirement}`,
              `   Proof: ${match.proofPoint}`,
              `   Note: ${match.notes}`
            ])
      };
    case "gaps":
      return {
        title: "Gaps And Strategy",
        lines: !hasRichReport
          ? ["No rich evaluation report yet. Run the offer report again to refresh this job."]
          : [
              `Target level: ${report.levelStrategy.targetLevel}`,
              `Positioning: ${report.levelStrategy.positioning}`,
              `Rationale: ${report.levelStrategy.rationale}`,
              "",
              "Gaps:",
              ...report.gaps.flatMap((gap) => [
                `- (${gap.severity}) ${gap.gap}`,
                `  Mitigation: ${gap.mitigation}`
              ]),
              "",
              "Risks:",
              ...report.levelStrategy.risks.map((risk) => `- ${risk}`)
            ]
      };
    case "research":
      return {
        title: "Deep Research",
        lines: record.research == null
          ? !hasRichReport
            ? ["Generate evaluation first."]
            : [
                "No deep research cached yet.",
                "Current strongest signals:",
                ...report.strongestSignals.map((signal) => `- ${signal}`),
                "",
                "Current risks:",
                ...report.riskSignals.map((signal) => `- ${signal}`)
              ]
          : [
              record.research.executiveSummary,
              "",
              `Business model: ${record.research.businessModel}`,
              "",
              "Product signals:",
              ...record.research.productSignals.map((signal) => `- ${signal}`),
              "",
              "Operating signals:",
              ...record.research.operatingSignals.map((signal) => `- ${signal}`),
              "",
              "Risks:",
              ...record.research.risks.map((risk) => `- ${risk}`)
            ]
      };
    case "contact":
      return {
        title: "Contact Draft",
        lines: record.contact == null
          ? ["No outreach draft cached yet."]
          : [
              `Subject: ${record.contact.subject}`,
              `Recipient: ${record.contact.recipientType}`,
              "",
              `Opener: ${record.contact.opener}`,
              "",
              "Talking points:",
              ...record.contact.talkingPoints.map((point) => `- ${point}`),
              "",
              ...record.contact.message.split(/\r?\n/)
            ]
      };
    case "summary":
    default:
      return {
        title: "Summary",
        lines: !hasRichReport
          ? [
              `Company: ${record.job.company}`,
              `Role: ${record.job.title}`,
              `Location: ${record.job.location}`,
              `Portal: ${record.job.portal}`,
              `URL: ${record.job.applyUrl}`,
              report == null ? "Awaiting evaluation." : "Legacy evaluation detected. Refresh the report to unlock the richer views."
            ]
          : [
              `Archetype: ${report.archetypeLabel}`,
              `Grade: ${report.grade}`,
              `Score: ${report.totalScore.toFixed(2)} / 5`,
              `Decision: ${report.recommendedAction}`,
              `Interview likelihood: ${report.interviewView.likelihood}%`,
              `Resume format: ${report.personalization.format}`,
              `Language: ${report.personalization.language}`,
              "",
              `Summary: ${report.summary}`,
              `Executive summary: ${report.executiveSummary}`,
              "",
              `Compensation: ${report.compensationView.verdict}`,
              `Comp details: ${record.job.compensationText ?? "Not disclosed"}`,
              "",
              "Strongest signals:",
              ...report.strongestSignals.map((signal) => `- ${signal}`)
            ]
      };
  }
}

export function buildDashboardView(records: JobRecordWithArtifacts[], selectedIndex = 0, tab: TabKey = "all", detailView: DetailViewKey = "summary"): DashboardView {
  const sortedRecords = sortByNewestPosted(records);
  const topRecords = sortedRecords.filter((record) => (record.evaluation?.totalScore ?? 0) >= 4);
  const noApplyRecords = sortedRecords.filter((record) => record.job.status === "rejected");
  const filtered = (() => {
    switch (tab) {
      case "evaluated":
        return sortedRecords.filter((record) => record.job.status === "evaluated" || record.job.status === "shortlisted" || record.job.status === "resume_ready" || record.job.status === "ready_to_apply" || record.job.status === "in_review");
      case "applied":
        return sortedRecords.filter((record) => record.job.status === "submitted");
      case "interview":
        return sortedRecords.filter((record) => record.job.status === "blocked");
      case "shortlisted":
        return sortedRecords.filter((record) => record.job.status === "shortlisted");
      case "top":
        return topRecords;
      case "no_apply":
        return noApplyRecords;
      default:
        return sortedRecords;
    }
  })();

  const current = filtered[Math.max(0, Math.min(selectedIndex, filtered.length - 1))] ?? sortedRecords[0] ?? null;
  const tableRows = filtered.map((record) => [
    (record.evaluation?.totalScore ?? 0).toFixed(1),
    record.evaluation?.grade ?? "-",
    record.job.company,
    record.job.title,
    formatPostedDate(record.job.postedAt),
    statusLabel(record),
    record.job.compensationText ?? "Not disclosed"
  ]);
  const detail = buildDetailLines(current, detailView);

  return {
    tabs: [
      { key: "all", label: "All", count: sortedRecords.length },
      { key: "evaluated", label: "Evaluated", count: sortedRecords.filter((record) => record.evaluation != null).length },
      { key: "shortlisted", label: "Shortlist", count: sortedRecords.filter((record) => record.job.status === "shortlisted").length },
      { key: "applied", label: "Applied", count: sortedRecords.filter((record) => record.job.status === "submitted").length },
      { key: "interview", label: "Interview", count: sortedRecords.filter((record) => record.job.status === "blocked").length },
      { key: "top", label: "Top >=4", count: topRecords.length },
      { key: "no_apply", label: "Do not apply", count: noApplyRecords.length }
    ],
    statusLine: [
      formatCount("Interview", sortedRecords.filter((record) => record.job.status === "blocked").length),
      formatCount("Applied", sortedRecords.filter((record) => record.job.status === "submitted").length),
      formatCount("Evaluated", sortedRecords.filter((record) => record.evaluation != null).length),
      formatCount("Resume ready", sortedRecords.filter((record) => record.job.status === "resume_ready").length),
      formatCount("Ready to apply", sortedRecords.filter((record) => record.job.status === "ready_to_apply" || record.job.status === "in_review").length),
      formatCount("Do not apply", noApplyRecords.length)
    ].join("   "),
    tableRows,
    detailTitle: detail.title,
    detailLines: detail.lines,
    visibleJobIds: filtered.map((record) => record.job.id)
  };
}

export function statusLabel(record: JobRecordWithArtifacts): string {
  if (record.job.status === "rejected") {
    return "Do not apply";
  }
  if (record.job.status === "submitted") {
    return "Applied";
  }
  if (record.job.status === "blocked") {
    return "Interview";
  }
  if (record.job.status === "ready_to_apply" || record.job.status === "in_review") {
    return "Ready to apply";
  }
  if (record.job.status === "resume_ready") {
    return "Resume ready";
  }
  if (record.job.status === "shortlisted") {
    return "Shortlisted";
  }
  return record.job.status;
}

