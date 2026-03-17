import path from "node:path";
import blessed from "neo-blessed";
import { CareerOpsRepository, canTransition, ensureDataPaths, type JobRecordWithArtifacts } from "@career-ops/core";
import { buildDashboardView, type TabKey } from "./state";

const rootDir = path.resolve(process.cwd());
const { dbPath } = ensureDataPaths(rootDir);
const repository = new CareerOpsRepository(dbPath);

const screen = blessed.screen({
  smartCSR: true,
  title: "Career pipeline"
});

const header = blessed.box({ top: 0, left: 0, width: "100%", height: 3, tags: true, style: { fg: "white" } });
const counters = blessed.box({ top: 3, left: 0, width: "100%", height: 3, tags: true, style: { fg: "white" } });
const controls = blessed.box({ top: 6, left: 0, width: "100%", height: 2, tags: true, style: { fg: "white" } });
const table = blessed.listtable({
  top: 8,
  left: 0,
  width: "100%",
  height: "65%-8",
  border: { type: "line" },
  align: "left",
  tags: true,
  keys: true,
  mouse: true,
  style: {
    header: { fg: "cyan", bold: true },
    cell: { fg: "white", selected: { bg: "blue" } },
    border: { fg: "gray" }
  }
});
const detail = blessed.box({
  bottom: 1,
  left: 0,
  width: "100%",
  height: "35%",
  border: { type: "line" },
  tags: true,
  padding: { left: 1, right: 1 }
});
const footer = blessed.box({ bottom: 0, left: 0, width: "100%", height: 1, tags: true, style: { fg: "white" } });

screen.append(header);
screen.append(counters);
screen.append(controls);
screen.append(table);
screen.append(detail);
screen.append(footer);

let tab: TabKey = "all";
let selectedIndex = 0;

function render(): void {
  const records = repository.listJobs();
  const view = buildDashboardView(records, selectedIndex, tab);
  header.setContent(`{cyan-fg}Career pipeline{/cyan-fg}\n${view.tabs.map((item) => `${item.key === tab ? '{blue-fg}' : ''}${item.label} (${item.count})${item.key === tab ? '{/blue-fg}' : ''}`).join('   ')}`);
  counters.setContent(view.statusLine);
  controls.setContent("[SORT: DATE]   [VIEW: GROUPED]   R REFRESH   1-6 TABS   X REJECT   A SHORTLIST   I INTERVIEW   O REASONING   Q QUIT");
  table.setData([["Score", "Company", "Title", "Status", "Comp"]].concat(view.tableRows));
  if (view.tableRows.length > 0) {
    table.select(Math.min(selectedIndex + 1, view.tableRows.length));
  }
  detail.setContent(view.detailLines.join("\n"));
  footer.setContent("nav  tabs  s sort  Enter report  c change  v view  Esc close");
  screen.render();
}

function withSelectedJob(action: (jobId: number) => void): void {
  const records = repository.listJobs();
  const view = buildDashboardView(records, selectedIndex, tab);
  const row = view.tableRows[selectedIndex];
  if (!row) {
    return;
  }
  const match = records.find((record: JobRecordWithArtifacts) => record.job.company === row[1] && record.job.title === row[2]);
  if (match) {
    action(match.job.id);
  }
}

screen.key(["q", "C-c", "escape"], () => {
  repository.close();
  return process.exit(0);
});

screen.key(["r"], render);
screen.key(["1"], () => { tab = "all"; selectedIndex = 0; render(); });
screen.key(["2"], () => { tab = "evaluated"; selectedIndex = 0; render(); });
screen.key(["3"], () => { tab = "applied"; selectedIndex = 0; render(); });
screen.key(["4"], () => { tab = "interview"; selectedIndex = 0; render(); });
screen.key(["5"], () => { tab = "top"; selectedIndex = 0; render(); });
screen.key(["6"], () => { tab = "no_apply"; selectedIndex = 0; render(); });
screen.key(["down", "j"], () => { selectedIndex += 1; render(); });
screen.key(["up", "k"], () => { selectedIndex = Math.max(0, selectedIndex - 1); render(); });
screen.key(["x"], () => {
  withSelectedJob((jobId) => {
    const record = repository.getJobRecord(jobId);
    if (canTransition(record.job.status, "rejected")) {
      repository.updateJobStatus(jobId, "rejected");
      render();
    }
  });
});
screen.key(["a"], () => {
  withSelectedJob((jobId) => {
    const record = repository.getJobRecord(jobId);
    if (canTransition(record.job.status, "shortlisted")) {
      repository.updateJobStatus(jobId, "shortlisted");
      render();
    }
  });
});
screen.key(["i"], () => {
  withSelectedJob((jobId) => {
    const record = repository.getJobRecord(jobId);
    if (canTransition(record.job.status, "blocked")) {
      repository.updateJobStatus(jobId, "blocked");
      render();
    }
  });
});
screen.key(["o", "enter"], () => {
  withSelectedJob((jobId) => {
    const record = repository.getJobRecord(jobId);
    const report = record.evaluation;
    detail.setContent(report == null
      ? "No evaluation report yet."
      : [
          `Archetype: ${report.archetypeLabel}`,
          `Total score: ${report.totalScore.toFixed(1)} / 5`,
          `Decision: ${report.recommendedAction}`,
          `Summary: ${report.summary}`,
          `Rejection reasons: ${report.rejectionReasons.join('; ') || 'n/a'}`
        ].join("\n"));
    screen.render();
  });
});

table.on("select", (_item: unknown, index: number) => {
  selectedIndex = Math.max(0, index - 1);
  render();
});

render();
