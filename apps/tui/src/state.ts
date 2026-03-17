import type { JobRecordWithArtifacts } from "@career-ops/core";

export type TabKey = "all" | "evaluated" | "applied" | "interview" | "top" | "no_apply";

export interface DashboardView {
  tabs: Array<{ key: TabKey; label: string; count: number }>;
  statusLine: string;
  tableRows: string[][];
  detailLines: string[];
}

function formatCount(label: string, count: number): string {
  return `${label}:${count}`;
}

export function buildDashboardView(records: JobRecordWithArtifacts[], selectedIndex = 0, tab: TabKey = "all"): DashboardView {
  const topRecords = records.filter((record) => (record.evaluation?.totalScore ?? 0) >= 4);
  const noApplyRecords = records.filter((record) => record.job.status === "rejected");
  const filtered = (() => {
    switch (tab) {
      case "evaluated":
        return records.filter((record) => record.job.status === "evaluated" || record.job.status === "shortlisted" || record.job.status === "resume_ready" || record.job.status === "ready_to_apply");
      case "applied":
        return records.filter((record) => record.job.status === "submitted");
      case "interview":
        return records.filter((record) => record.job.status === "blocked");
      case "top":
        return topRecords;
      case "no_apply":
        return noApplyRecords;
      default:
        return records;
    }
  })();

  const current = filtered[Math.max(0, Math.min(selectedIndex, filtered.length - 1))] ?? records[0] ?? null;
  const tableRows = filtered.map((record) => [
    (record.evaluation?.totalScore ?? 0).toFixed(1),
    record.job.company,
    record.job.title,
    statusLabel(record),
    record.job.compensationText ?? "Not disclosed"
  ]);

  return {
    tabs: [
      { key: "all", label: "All", count: records.length },
      { key: "evaluated", label: "Evaluated", count: records.filter((record) => record.evaluation != null).length },
      { key: "applied", label: "Applied", count: records.filter((record) => record.job.status === "submitted").length },
      { key: "interview", label: "Interview", count: records.filter((record) => record.job.status === "blocked").length },
      { key: "top", label: "Top >=4", count: topRecords.length },
      { key: "no_apply", label: "Do not apply", count: noApplyRecords.length }
    ],
    statusLine: [
      formatCount("Interview", records.filter((record) => record.job.status === "blocked").length),
      formatCount("Applied", records.filter((record) => record.job.status === "submitted").length),
      formatCount("Evaluated", records.filter((record) => record.evaluation != null).length),
      formatCount("Do not apply", noApplyRecords.length)
    ].join("   "),
    tableRows,
    detailLines: current == null
      ? ["No jobs loaded."]
      : [
          `Archetype: ${current.evaluation?.archetypeLabel ?? "Pending"}`,
          `TL;DR: ${current.evaluation?.summary ?? "Awaiting evaluation"}`,
          `Remote: ${current.job.location}`,
          `Portal: ${current.job.portal}`,
          `URL: ${current.job.applyUrl}`
        ]
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
    return "Ready";
  }
  if (record.job.status === "resume_ready" || record.job.status === "shortlisted") {
    return "Top";
  }
  return record.job.status;
}
