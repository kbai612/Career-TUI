import { spawn } from "node:child_process";
import path from "node:path";
import blessed from "neo-blessed";
import { CareerOpsPipeline, canTransition, ensureDataPaths, loadRootEnv, type ApplicationState } from "@career-ops/core";
import { openExternalUrl } from "./browser";
import { buildDashboardTableData, buildDashboardView, type DetailViewKey, type TabKey } from "./state";

const rootDir = path.resolve(process.cwd());
loadRootEnv(rootDir);
const { dbPath } = ensureDataPaths(rootDir);
const workerEntrypoint = path.resolve(rootDir, "apps", "worker", "dist", "apps", "worker", "src", "index.js");
const pipeline = new CareerOpsPipeline(rootDir, dbPath);
const repository = pipeline.repo;
const detailViews: DetailViewKey[] = ["summary", "cv", "gaps", "research", "contact"];

const screen = blessed.screen({
  smartCSR: true,
  title: "Career pipeline"
});

const header = blessed.box({ top: 0, left: 0, width: "100%", height: 3, tags: true, style: { fg: "white" } });
const headerStats = blessed.box({ top: 0, right: 1, width: "40%", height: 1, tags: true, align: "right", style: { fg: "white" } });
const counters = blessed.box({ top: 3, left: 0, width: "100%", height: 3, tags: true, style: { fg: "white" } });
const controls = blessed.box({ top: 6, left: 0, width: "100%", height: 1, tags: true, style: { fg: "white" } });
const table = blessed.listtable({
  top: 7,
  left: 0,
  width: "100%",
  height: "65%-7",
  border: { type: "line" },
  align: "left",
  tags: true,
  // Keep row navigation centralized in screen-level handlers to avoid double-handling arrows.
  keys: false,
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
  padding: { left: 1, right: 1 },
  scrollable: true,
  alwaysScroll: true,
  wrap: true,
  mouse: true,
  keys: true,
  vi: true,
  scrollbar: {
    ch: " ",
    track: { bg: "gray" },
    style: { bg: "white" }
  },
  label: " SUMMARY "
});
const reportViewer = blessed.box({
  top: 0,
  left: 0,
  width: "100%",
  height: "100%-1",
  border: { type: "line" },
  tags: true,
  padding: { left: 1, right: 1 },
  scrollable: true,
  alwaysScroll: true,
  wrap: true,
  mouse: true,
  keys: true,
  vi: true,
  hidden: true,
  label: " REPORT ",
  scrollbar: {
    ch: " ",
    track: { bg: "gray" },
    style: { bg: "white" }
  }
});
const actionsPanel = blessed.box({
  top: 8,
  left: 0,
  width: "100%",
  height: "100%-9",
  hidden: true
});
const actionsButtonsPane = blessed.box({
  parent: actionsPanel,
  top: 0,
  left: 0,
  width: "100%",
  height: "40%",
  border: { type: "line" },
  label: " COMMANDS ",
  tags: true,
  scrollable: true,
  alwaysScroll: true,
  mouse: true,
  keys: true,
  vi: true,
  style: { border: { fg: "cyan" } }
});
const actionsDescription = blessed.box({
  parent: actionsPanel,
  top: "40%",
  left: 0,
  width: "100%",
  height: "16%",
  border: { type: "line" },
  label: " DESCRIPTION ",
  tags: true,
  padding: { left: 1, right: 1 },
  wrap: true,
  style: { border: { fg: "gray" }, fg: "white" }
});
const actionsOutput = blessed.box({
  parent: actionsPanel,
  top: "56%",
  left: 0,
  width: "100%",
  height: "44%",
  border: { type: "line" },
  label: " OUTPUT ",
  tags: true,
  padding: { left: 1, right: 1 },
  scrollable: true,
  alwaysScroll: true,
  wrap: true,
  mouse: true,
  keys: true,
  vi: true,
  scrollbar: {
    ch: " ",
    track: { bg: "gray" },
    style: { bg: "white" }
  },
  style: { border: { fg: "cyan" } }
});
const footer = blessed.box({ bottom: 0, left: 0, width: "100%", height: 1, tags: true, style: { fg: "white" } });

screen.append(header);
screen.append(headerStats);
screen.append(counters);
screen.append(controls);
screen.append(table);
screen.append(detail);
screen.append(reportViewer);
screen.append(actionsPanel);
screen.append(footer);

let tab: TabKey = "all";
let selectedIndex = 0;
let detailView: DetailViewKey = "summary";
let detailScrollOffset = 0;
let reportViewerScrollOffset = 0;
let reportViewerOpen = false;
let statusMessage = "READY";
let actionsViewOpen = false;
let actionsOutputScrollOffset = 0;
let actionInProgress = false;
let actionsFocusIndex = 0;
let syncingTableSelection = false;
let refreshInProgress = false;
let refreshAnimationIndex = 0;
let refreshAnimationTimer: NodeJS.Timeout | null = null;
let refreshAnimationTickCount = 0;

const REFRESH_DOT_FRAMES = [".", "..", "...", " "] as const;

function actionTimestamp(): string {
  return new Date().toISOString();
}

const actionOutputEntries: string[] = [
  `[${actionTimestamp()}] Active`
];
const actionButtons: any[] = [];
const ACTION_BUTTON_COLUMNS = 2;
const ACTION_BUTTON_HEIGHT = 3;
const DASHBOARD_FOOTER_CONTROLS = "R: REFRESH   L: OPEN LINK   LEFT/RIGHT: TABS   8: ACTIONS   X: REJECT   S: SHORTLIST   A: APPLIED   I: INTERVIEW   D: RESEARCH   M: CONTACT   V: NEXT VIEW   :Q QUIT";
const REFRESH_ANIMATION_INTERVAL_MS = 120;
const REFRESH_ANIMATION_MIN_MS = 700;
const TAB_ORDER: TabKey[] = ["all", "evaluated", "shortlisted", "applied", "interview", "top", "no_apply"];

interface ManualAction {
  label: string;
  buttonLabel?: string;
  hint: string;
  description: string;
  run: () => Promise<string | void> | string | void;
}

let manualActions: ManualAction[] = [];
type StoredSource = ReturnType<CareerOpsPipeline["listSources"]>[number];

function toTitleCase(value: string): string {
  return value
    .split(/[\s_-]+/)
    .filter((part) => part.length > 0)
    .map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1).toLowerCase()}`)
    .join(" ");
}

function sourceWebsiteKey(source: StoredSource): string {
  if (source.kind === "linkedin") {
    return "linkedin";
  }
  if (source.kind === "levels") {
    return "levels";
  }
  if (source.kind === "greenhouse") {
    return "greenhouse";
  }
  if (source.kind === "lever") {
    return "lever";
  }

  try {
    const hostname = new URL(source.sourceUrl).hostname.replace(/^www\./i, "").toLowerCase();
    if (hostname.includes("workopolis")) {
      return "workopolis";
    }
    if (hostname.includes("indeed")) {
      return "indeed";
    }
    if (hostname.includes("simplyhired")) {
      return "simplyhired";
    }
    if (hostname.includes("workday")) {
      return "workday";
    }
    if (hostname.includes("ashby")) {
      return "ashby";
    }
    const hostParts = hostname.split(".").filter((part) => part.length > 0);
    if (hostParts.length >= 2) {
      return hostParts[hostParts.length - 2] ?? hostname;
    }
    return hostname || source.kind;
  } catch {
    return source.kind;
  }
}

function sourceWebsiteLabel(websiteKey: string): string {
  switch (websiteKey) {
    case "linkedin":
      return "LinkedIn";
    case "levels":
      return "Levels";
    case "greenhouse":
      return "Greenhouse";
    case "lever":
      return "Lever";
    case "workopolis":
      return "Workopolis";
    case "indeed":
      return "Indeed";
    case "simplyhired":
      return "SimplyHired";
    case "workday":
      return "Workday";
    case "ashby":
      return "Ashby";
    default:
      return toTitleCase(websiteKey);
  }
}

function setWebsiteSourcesActive(websiteKey: string, nextActive: boolean): string {
  const allSources = pipeline.listSources({ activeOnly: false });
  const websiteSources = allSources.filter((source) => sourceWebsiteKey(source) === websiteKey);
  if (websiteSources.length === 0) {
    return `No sources found for ${sourceWebsiteLabel(websiteKey)}.`;
  }

  let changed = 0;
  for (const source of websiteSources) {
    if (source.active === nextActive) {
      continue;
    }
    pipeline.registerSource({
      name: source.name,
      sourceUrl: source.sourceUrl,
      kind: source.kind,
      regionId: source.regionId,
      active: nextActive,
      usePersistentBrowser: source.usePersistentBrowser,
      metadata: source.metadata,
      lastSyncedAt: source.lastSyncedAt,
      lastStatus: source.lastStatus
    });
    changed += 1;
  }

  const label = sourceWebsiteLabel(websiteKey);
  const verb = nextActive ? "enabled" : "disabled";
  return `${label}: ${verb} ${changed} source(s) (${websiteSources.length - changed} unchanged).`;
}

function buildSourceToggleActions(): ManualAction[] {
  const allSources = pipeline.listSources({ activeOnly: false });
  const groups = new Map<string, StoredSource[]>();
  for (const source of allSources) {
    const key = sourceWebsiteKey(source);
    const existing = groups.get(key);
    if (existing == null) {
      groups.set(key, [source]);
    } else {
      existing.push(source);
    }
  }

  return Array.from(groups.entries())
    .sort(([leftKey], [rightKey]) => sourceWebsiteLabel(leftKey).localeCompare(sourceWebsiteLabel(rightKey)))
    .map(([websiteKey, sources]) => {
      const activeCount = sources.filter((source) => source.active).length;
      const totalCount = sources.length;
      const websiteEnabled = activeCount > 0;
      const nextActive = !websiteEnabled;
      const nextVerb = nextActive ? "enable" : "disable";
      const label = sourceWebsiteLabel(websiteKey);
      const statusWord = websiteEnabled ? "ENABLED" : "DISABLED";
      const statusTag = websiteEnabled
        ? "{green-fg}ENABLED{/green-fg}"
        : "{red-fg}DISABLED{/red-fg}";
      return {
        label: `${label} ${statusWord}`,
        buttonLabel: `${label} ${statusTag}`,
        hint: `${activeCount}/${totalCount} active | next: ${nextVerb} all`,
        description: `${label} is currently ${statusWord}.\nCurrently active: ${activeCount}/${totalCount}.\nPress to ${nextVerb} every ${label} source.`,
        run: () => setWebsiteSourcesActive(websiteKey, nextActive)
      };
    });
}

function currentView() {
  return buildDashboardView(repository.listJobs(), selectedIndex, tab, detailView);
}

function getTableWidth(): number {
  return typeof table.width === "number" ? table.width : screen.width;
}

function maxSelectedIndex(): number {
  return Math.max(0, currentView().visibleJobIds.length - 1);
}

function clampScrollOffset(element: any, nextOffset: number): number {
  const maxOffset = Math.max(0, element.getScrollHeight() - element.height);
  return Math.max(0, Math.min(maxOffset, nextOffset));
}

function resetDetailScroll(): void {
  detailScrollOffset = 0;
}

function resetReportViewerScroll(): void {
  reportViewerScrollOffset = 0;
}

function setStatusMessage(message: string): void {
  statusMessage = message.toUpperCase();
}

function startRefreshAnimation(): void {
  if (refreshAnimationTimer != null) {
    clearInterval(refreshAnimationTimer);
  }
  refreshInProgress = true;
  refreshAnimationIndex = 0;
  refreshAnimationTickCount = 0;
  refreshAnimationTimer = setInterval(() => {
    refreshAnimationIndex = (refreshAnimationIndex + 1) % REFRESH_DOT_FRAMES.length;
    refreshAnimationTickCount += 1;
    render();
  }, REFRESH_ANIMATION_INTERVAL_MS);
}

function stopRefreshAnimation(): void {
  if (refreshAnimationTimer != null) {
    clearInterval(refreshAnimationTimer);
    refreshAnimationTimer = null;
  }
  refreshInProgress = false;
  refreshAnimationIndex = 0;
  refreshAnimationTickCount = 0;
}

function getActiveStatusMessage(): string {
  if (!refreshInProgress) {
    return statusMessage;
  }
  return `REFRESHING${REFRESH_DOT_FRAMES[refreshAnimationIndex]}`;
}

async function waitForRefreshAnimationProgress(startedAt: number): Promise<void> {
  while (true) {
    const elapsed = Date.now() - startedAt;
    const hasMinimumDuration = elapsed >= REFRESH_ANIMATION_MIN_MS;
    const hasMinimumFrames = refreshAnimationTickCount >= 3;
    if (hasMinimumDuration && hasMinimumFrames) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
}

function syncActionsOutputBox(): void {
  actionsOutput.setContent(actionOutputEntries.join("\n\n"));
  actionsOutputScrollOffset = clampScrollOffset(actionsOutput, actionsOutputScrollOffset);
  actionsOutput.setScroll(actionsOutputScrollOffset);
}

function appendActionOutput(message: string): void {
  const normalized = message.trim().length > 0 ? message.trim() : "(no output)";
  actionOutputEntries.push(`[${actionTimestamp()}] ${normalized}`);
  if (actionOutputEntries.length > 140) {
    actionOutputEntries.splice(1, actionOutputEntries.length - 140);
  }
  actionsOutputScrollOffset = Number.MAX_SAFE_INTEGER;
  syncActionsOutputBox();
}

async function runWorkerCommand(
  args: string[],
  onOutput?: (chunk: string, stream: "stdout" | "stderr") => void
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [workerEntrypoint, ...args], {
      cwd: rootDir,
      windowsHide: true
    });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      const text = String(chunk);
      stdout += text;
      onOutput?.(text, "stdout");
    });
    child.stderr.on("data", (chunk) => {
      const text = String(chunk);
      stderr += text;
      onOutput?.(text, "stderr");
    });
    child.on("error", (error) => {
      reject(error);
    });
    child.on("close", (code) => {
      const combinedOutput = [stdout.trim(), stderr.trim()].filter((value) => value.length > 0).join("\n");
      if (code === 0) {
        resolve(combinedOutput || `Command completed: ${args.join(" ")}`);
        return;
      }
      reject(new Error(combinedOutput || `Command failed with exit code ${code ?? -1}`));
    });
  });
}

async function runWorkerCommandLive(args: string[]): Promise<void> {
  let pendingStdout = "";
  let pendingStderr = "";
  await runWorkerCommand(args, (chunk, stream) => {
    if (stream === "stdout") {
      pendingStdout += chunk;
      const lines = pendingStdout.split(/\r?\n/);
      pendingStdout = lines.pop() ?? "";
      for (const line of lines) {
        if (line.trim().length > 0) {
          appendActionOutput(line.trim());
        }
      }
      return;
    }

    pendingStderr += chunk;
    const lines = pendingStderr.split(/\r?\n/);
    pendingStderr = lines.pop() ?? "";
    for (const line of lines) {
      if (line.trim().length > 0) {
        appendActionOutput(`[stderr] ${line.trim()}`);
      }
    }
  });

  const finalStdout = pendingStdout.trim();
  if (finalStdout.length > 0) {
    appendActionOutput(finalStdout);
  }
  const finalStderr = pendingStderr.trim();
  if (finalStderr.length > 0) {
    appendActionOutput(`[stderr] ${finalStderr}`);
  }
}

function getSelectedJobIdOrThrow(): number {
  const view = currentView();
  const jobId = view.visibleJobIds[selectedIndex];
  if (jobId == null) {
    throw new Error("No job selected in the current tab.");
  }
  return jobId;
}

function setActionDescription(index: number): void {
  const action = manualActions[index];
  if (action == null) {
    actionsDescription.setContent("No action selected.");
    return;
  }
  actionsDescription.setContent(`{cyan-fg}${action.label}{/cyan-fg}\n${action.description}`);
}

function focusManualAction(nextIndex: number): void {
  if (actionButtons.length === 0) {
    return;
  }
  actionsFocusIndex = Math.max(0, Math.min(nextIndex, actionButtons.length - 1));
  const button = actionButtons[actionsFocusIndex];
  button.focus();
  const actionRow = Math.floor(actionsFocusIndex / ACTION_BUTTON_COLUMNS);
  const targetScroll = Math.max(0, actionRow * ACTION_BUTTON_HEIGHT - ACTION_BUTTON_HEIGHT);
  actionsButtonsPane.setScroll(targetScroll);
  setActionDescription(actionsFocusIndex);
  screen.render();
}

function scrollActionsOutput(delta: number): void {
  actionsOutputScrollOffset = clampScrollOffset(actionsOutput, actionsOutputScrollOffset + delta);
  actionsOutput.setScroll(actionsOutputScrollOffset);
  screen.render();
}

function isMissingResumeErrorMessage(message: string): boolean {
  return /resume path is required/i.test(message)
    || /CAREER_OPS_UPLOADED_RESUME/i.test(message);
}

const baseManualActions: ManualAction[] = [
  {
    label: "Seed Toronto Sources",
    hint: "Reset and seed the default Toronto source pack",
    description: "Upserts the default Toronto source registry entries and disables retired defaults.",
    run: () => runWorkerCommandLive(["seed-toronto-sources"])
  },
  {
    label: "Sync Sources (Crawl Only)",
    hint: "Run source crawling without evaluation",
    description: "Runs source sync for toronto-canada with crawl-only mode. No scoring is executed.",
    run: () => runWorkerCommandLive(["sync-sources", "--region", "toronto-canada", "--concurrency", "3", "--skip-evaluate"])
  },
  {
    label: "Sync Sources + Evaluate",
    hint: "Run source crawling and evaluate normalized jobs",
    description: "Runs source sync for toronto-canada and then evaluates normalized jobs in bulk.",
    run: () => runWorkerCommandLive(["sync-sources", "--region", "toronto-canada", "--concurrency", "3", "--evaluate"])
  },
  {
    label: "Clear All Listings",
    hint: "Delete all job rows and artifacts",
    description: "Deletes every listing and related evaluation/resume/application/research/contact record from the local database.",
    run: () => runWorkerCommandLive(["clear-listings"])
  },
  {
    label: "Evaluate Pending",
    hint: "Evaluate up to 250 normalized jobs",
    description: "Evaluates jobs in normalized state directly from the pipeline without spawning the worker command.",
    run: async () => JSON.stringify(await pipeline.evaluatePending(250), null, 2)
  },
  {
    label: "Evaluate Selected Job",
    hint: "Evaluate the currently selected row",
    description: "Evaluates the job currently selected in the active tab and updates stored score/report state.",
    run: async () => {
      const jobId = getSelectedJobIdOrThrow();
      const report = await pipeline.evaluateJob(jobId);
      return `Evaluated #${jobId}: grade ${report.grade} | score ${report.totalScore.toFixed(2)} | ${report.recommendedAction}`;
    }
  },
  {
    label: "List Excluded Companies",
    hint: "Show globally excluded company filters",
    description: "Prints all excluded companies that will be filtered out during crawl ingestion.",
    run: () => runWorkerCommandLive(["list-excluded-companies"])
  },
  {
    label: "List Answer Memory",
    hint: "Show reusable application answers",
    description: "Prints reusable question/answer memory entries and usage counts.",
    run: () => runWorkerCommandLive(["list-answer-memory"])
  },
  {
    label: "Resume Feedback Summary",
    hint: "Show resume variant performance stats",
    description: "Prints aggregate outcome and keyword-level signal summary from stored resume feedback.",
    run: () => runWorkerCommandLive(["resume-feedback-summary"])
  },
  {
    label: "Autoapply Shortlist",
    hint: "Bulk prefill shortlist jobs with uploaded resume",
    description: "Runs worker autoapply-shortlist. Set CAREER_OPS_UPLOADED_RESUME (and optional CAREER_OPS_AUTOAPPLY_INFO_JSON / CAREER_OPS_AUTOAPPLY_SUBMIT=1). OS-level mode can move your real cursor and type real keystrokes.",
    run: async () => {
      try {
        return await runWorkerCommand(["autoapply-shortlist"]);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (isMissingResumeErrorMessage(message)) {
          throw new Error("ERROR: MISSING RESUME");
        }
        throw error;
      }
    }
  }
];

function buildManualActions(): ManualAction[] {
  return [...baseManualActions, ...buildSourceToggleActions()];
}

const applicationStates: ApplicationState[] = [
  "discovered",
  "normalized",
  "evaluated",
  "rejected",
  "shortlisted",
  "resume_ready",
  "ready_to_apply",
  "in_review",
  "submitted",
  "blocked",
  "error"
];

function findStatusPath(from: ApplicationState, to: ApplicationState): ApplicationState[] | null {
  if (from === to) {
    return [from];
  }

  const queue: Array<{ state: ApplicationState; path: ApplicationState[] }> = [{ state: from, path: [from] }];
  const visited = new Set<ApplicationState>([from]);

  while (queue.length > 0) {
    const current = queue.shift();
    if (current == null) {
      continue;
    }

    for (const candidate of applicationStates) {
      if (!canTransition(current.state, candidate) || visited.has(candidate)) {
        continue;
      }
      const nextPath = [...current.path, candidate];
      if (candidate === to) {
        return nextPath;
      }
      visited.add(candidate);
      queue.push({ state: candidate, path: nextPath });
    }
  }

  return null;
}

function markJobAsApplied(jobId: number): { ok: boolean; message: string } {
  const record = repository.getJobRecord(jobId);
  const company = record.job.company;
  if (record.job.status === "submitted") {
    return { ok: true, message: `${company} already marked as applied` };
  }

  const path = findStatusPath(record.job.status, "submitted");
  if (path == null) {
    return { ok: false, message: `Cannot mark applied from ${record.job.status}` };
  }

  for (const nextStatus of path.slice(1)) {
    repository.updateJobStatus(jobId, nextStatus);
  }
  return { ok: true, message: `Applied to ${company}` };
}

async function runManualAction(index: number): Promise<void> {
  const action = manualActions[index];
  if (action == null) {
    return;
  }
  if (actionInProgress) {
    setStatusMessage("Another action is already running");
    render();
    return;
  }

  actionInProgress = true;
  actionsFocusIndex = index;
  setStatusMessage(`Running ${action.label}`);
  appendActionOutput(`Running ${action.label}`);
  render();

  try {
    const output = await action.run();
    if (typeof output === "string" && output.trim().length > 0) {
      appendActionOutput(output);
    }
    setStatusMessage(`Completed ${action.label}`);
    resetDetailScroll();
    resetReportViewerScroll();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message === "ERROR: MISSING RESUME") {
      appendActionOutput(message);
    } else {
      appendActionOutput(`${action.label} failed\n${message}`);
    }
    setStatusMessage(`Failed ${action.label}`);
  } finally {
    actionInProgress = false;
    repository.refreshJobs();
    reloadActionButtons();
    render();
    if (actionsViewOpen) {
      focusManualAction(actionsFocusIndex);
    }
  }
}

function clearActionButtons(): void {
  const focusedElement = screen.focused as any;
  if (focusedElement != null && actionButtons.includes(focusedElement)) {
    actionsButtonsPane.focus();
  }
  for (const button of actionButtons.splice(0, actionButtons.length)) {
    button.detach();
    button.destroy();
  }
  actionsButtonsPane.setScroll(0);
}

function reloadActionButtons(): void {
  manualActions = buildManualActions();
  if (actionsFocusIndex > Math.max(0, manualActions.length - 1)) {
    actionsFocusIndex = Math.max(0, manualActions.length - 1);
  }
  clearActionButtons();
  initializeActionButtons();
}

function initializeActionButtons(): void {
  manualActions.forEach((action, index) => {
    const row = Math.floor(index / ACTION_BUTTON_COLUMNS);
    const column = index % ACTION_BUTTON_COLUMNS;
    const button = blessed.button({
      parent: actionsButtonsPane,
      top: row * ACTION_BUTTON_HEIGHT,
      left: column === 0 ? 1 : "50%+1",
      width: "50%-2",
      height: ACTION_BUTTON_HEIGHT,
      mouse: true,
      keys: false,
      tags: true,
      shrink: false,
      border: { type: "line" },
      content: ` ${action.buttonLabel ?? action.label}\n {gray-fg}${action.hint}{/gray-fg}`,
      style: {
        fg: "white",
        bg: "black",
        border: { fg: "white" },
        focus: { fg: "black", bg: "lightgray", border: { fg: "cyan" } },
        hover: { fg: "black", bg: "lightgray", border: { fg: "cyan" } }
      }
    });
    button.on("press", () => {
      actionsFocusIndex = index;
      void runManualAction(index);
    });
    button.on("focus", () => {
      actionsFocusIndex = index;
      setActionDescription(index);
      if (actionsViewOpen) {
        screen.render();
      }
    });
    button.on("mouseover", () => {
      if (!actionsViewOpen) {
        return;
      }
      focusManualAction(index);
    });
    actionButtons.push(button);
  });
  setActionDescription(actionsFocusIndex);
  syncActionsOutputBox();
}

function openReportViewer(): void {
  reportViewerOpen = true;
  resetReportViewerScroll();
  reportViewer.show();
  reportViewer.setFront();
  reportViewer.focus();
  render();
}

function closeReportViewer(): void {
  reportViewerOpen = false;
  reportViewer.hide();
  screen.focusPop();
  render();
}

function openActionsView(): void {
  if (reportViewerOpen) {
    reportViewerOpen = false;
    reportViewer.hide();
  }
  reloadActionButtons();
  actionsViewOpen = true;
  render();
  focusManualAction(actionsFocusIndex);
}

function closeActionsView(): void {
  actionsViewOpen = false;
  render();
  table.focus();
}

function withSelectedJob(action: (jobId: number) => void): void {
  const view = currentView();
  const jobId = view.visibleJobIds[selectedIndex];
  if (jobId != null) {
    action(jobId);
  }
}

async function refreshDashboard(): Promise<void> {
  if (refreshInProgress) {
    return;
  }
  const startedAt = Date.now();
  startRefreshAnimation();
  render();
  await new Promise((resolve) => setTimeout(resolve, 0));
  try {
    repository.refreshJobs();
    await waitForRefreshAnimationProgress(startedAt);
    setStatusMessage("Refreshed");
  } finally {
    stopRefreshAnimation();
    render();
  }
}

async function withSelectedJobAsync(action: (jobId: number) => Promise<void>): Promise<void> {
  const view = currentView();
  const jobId = view.visibleJobIds[selectedIndex];
  if (jobId != null) {
    await action(jobId);
  }
}

function cycleDetailView(): void {
  const currentIndex = detailViews.indexOf(detailView);
  detailView = detailViews[(currentIndex + 1) % detailViews.length];
  resetDetailScroll();
  resetReportViewerScroll();
}

function cycleTab(delta: -1 | 1): void {
  const currentIndex = TAB_ORDER.indexOf(tab);
  const safeCurrentIndex = currentIndex >= 0 ? currentIndex : 0;
  const nextIndex = (safeCurrentIndex + delta + TAB_ORDER.length) % TAB_ORDER.length;
  tab = TAB_ORDER[nextIndex];
  selectedIndex = 0;
  resetDetailScroll();
  resetReportViewerScroll();
  render();
}

function render(): void {
  const records = repository.listJobs();
  const average = records.filter((record) => record.evaluation != null).reduce((sum, record) => sum + (record.evaluation?.totalScore ?? 0), 0);
  const averageScore = records.some((record) => record.evaluation != null)
    ? average / Math.max(1, records.filter((record) => record.evaluation != null).length)
    : 0;
  const view = buildDashboardView(records, selectedIndex, tab, detailView);
  selectedIndex = Math.max(0, Math.min(selectedIndex, Math.max(0, view.visibleJobIds.length - 1)));
  if (actionsViewOpen) {
    header.height = 1;
    actionsPanel.top = 1;
    actionsPanel.height = "100%-2";
    header.setContent("{cyan-fg}Actions View{/cyan-fg}");
    headerStats.hide();
    counters.hide();
    controls.hide();
  } else {
    header.height = 3;
    actionsPanel.top = 8;
    actionsPanel.height = "100%-9";
    const tabLine = view.tabs
      .map((item) => `${item.key === tab ? "{blue-fg}" : ""}${item.label} (${item.count})${item.key === tab ? "{/blue-fg}" : ""}`)
      .join("   ");
    header.setContent(`{cyan-fg}Career pipeline{/cyan-fg}\n${tabLine}`);
    headerStats.setContent(`${records.length} Listings | Avg ${averageScore.toFixed(1)}/5`);
    counters.setContent(view.statusLine);
    headerStats.show();
    counters.show();
    controls.show();
  }
  table.setData(buildDashboardTableData(view.tableRows, getTableWidth()));
  if (view.tableRows.length > 0) {
    syncingTableSelection = true;
    table.select(Math.min(selectedIndex + 1, view.tableRows.length));
    syncingTableSelection = false;
    const currentTableScroll = table.getScroll();
    const maxTableScroll = Math.max(0, table.getScrollHeight() - table.height);
    const clampedTableScroll = Math.max(0, Math.min(currentTableScroll, maxTableScroll));
    table.setScroll(selectedIndex === 0 ? 0 : clampedTableScroll);
  } else {
    table.setScroll(0);
  }
  detail.setLabel(` ${view.detailTitle.toUpperCase()} `);
  detail.setContent(view.detailLines.join("\n"));
  detail.setScroll(detailScrollOffset);
  reportViewer.setLabel(` ${view.detailTitle.toUpperCase()} REPORT `);
  reportViewer.setContent(view.detailLines.join("\n"));
  reportViewer.setScroll(reportViewerScrollOffset);
  syncActionsOutputBox();

  if (actionsViewOpen) {
    actionsPanel.show();
    actionsPanel.setFront();
    table.hide();
    detail.hide();
    reportViewer.hide();
    footer.setContent("Actions View");
  } else {
    actionsPanel.hide();
    table.show();
    detail.show();
    if (reportViewerOpen) {
      reportViewer.show();
      reportViewer.setFront();
    } else {
      reportViewer.hide();
    }
    controls.setContent(`[SORT: DATE DESC]   [VIEW: ${detailView.toUpperCase()}]`);
    const activeStatusMessage = getActiveStatusMessage();
    const dashboardFooterContent = refreshInProgress
      ? `${activeStatusMessage}   ${DASHBOARD_FOOTER_CONTROLS}`
      : DASHBOARD_FOOTER_CONTROLS;
    footer.setContent(reportViewerOpen
      ? `${activeStatusMessage}   L OPEN LINK  UP/DOWN SCROLL  PGUP/PGDN PAGE  HOME/END JUMP  ESC CLOSE VIEWER  Q QUIT`
      : dashboardFooterContent);
  }

  screen.render();
}

screen.key(["q", "C-c"], () => {
  stopRefreshAnimation();
  pipeline.dispose();
  return process.exit(0);
});

screen.key(["escape"], () => {
  if (actionsViewOpen) {
    closeActionsView();
    return;
  }
  if (reportViewerOpen) {
    closeReportViewer();
    return;
  }
  stopRefreshAnimation();
  pipeline.dispose();
  return process.exit(0);
});

screen.key(["8"], () => {
  if (actionsViewOpen) {
    closeActionsView();
    return;
  }
  openActionsView();
});

screen.key(["r", "R"], () => {
  void refreshDashboard();
});

screen.key(["v"], () => {
  if (actionsViewOpen) {
    return;
  }
  cycleDetailView();
  render();
});

screen.key(["o", "enter"], () => {
  if (actionsViewOpen) {
    void runManualAction(actionsFocusIndex);
    return;
  }
  if (reportViewerOpen) {
    closeReportViewer();
    return;
  }
  openReportViewer();
});

screen.key(["pageup"], () => {
  if (actionsViewOpen) {
    scrollActionsOutput(-6);
    return;
  }
  if (reportViewerOpen) {
    reportViewerScrollOffset = clampScrollOffset(reportViewer, reportViewerScrollOffset - 10);
    reportViewer.setScroll(reportViewerScrollOffset);
    screen.render();
    return;
  }
  detailScrollOffset = clampScrollOffset(detail, detailScrollOffset - 6);
  detail.setScroll(detailScrollOffset);
  screen.render();
});

screen.key(["pagedown"], () => {
  if (actionsViewOpen) {
    scrollActionsOutput(6);
    return;
  }
  if (reportViewerOpen) {
    reportViewerScrollOffset = clampScrollOffset(reportViewer, reportViewerScrollOffset + 10);
    reportViewer.setScroll(reportViewerScrollOffset);
    screen.render();
    return;
  }
  detailScrollOffset = clampScrollOffset(detail, detailScrollOffset + 6);
  detail.setScroll(detailScrollOffset);
  screen.render();
});

screen.key(["home"], () => {
  if (actionsViewOpen) {
    actionsOutputScrollOffset = 0;
    actionsOutput.setScroll(0);
    screen.render();
    return;
  }
  if (reportViewerOpen) {
    reportViewerScrollOffset = 0;
    reportViewer.setScroll(0);
    screen.render();
    return;
  }
  detailScrollOffset = 0;
  detail.setScroll(0);
  screen.render();
});

screen.key(["end"], () => {
  if (actionsViewOpen) {
    actionsOutputScrollOffset = clampScrollOffset(actionsOutput, actionsOutput.getScrollHeight());
    actionsOutput.setScroll(actionsOutputScrollOffset);
    screen.render();
    return;
  }
  if (reportViewerOpen) {
    reportViewerScrollOffset = clampScrollOffset(reportViewer, reportViewer.getScrollHeight());
    reportViewer.setScroll(reportViewerScrollOffset);
    screen.render();
    return;
  }
  detailScrollOffset = clampScrollOffset(detail, detail.getScrollHeight());
  detail.setScroll(detailScrollOffset);
  screen.render();
});

screen.key(["down", "j"], () => {
  if (actionsViewOpen) {
    focusManualAction(actionsFocusIndex + ACTION_BUTTON_COLUMNS);
    return;
  }
  if (reportViewerOpen) {
    reportViewerScrollOffset = clampScrollOffset(reportViewer, reportViewerScrollOffset + 1);
    reportViewer.setScroll(reportViewerScrollOffset);
    screen.render();
    return;
  }
  selectedIndex = Math.min(selectedIndex + 1, maxSelectedIndex());
  resetDetailScroll();
  render();
});

screen.key(["up", "k"], () => {
  if (actionsViewOpen) {
    focusManualAction(actionsFocusIndex - ACTION_BUTTON_COLUMNS);
    return;
  }
  if (reportViewerOpen) {
    reportViewerScrollOffset = clampScrollOffset(reportViewer, reportViewerScrollOffset - 1);
    reportViewer.setScroll(reportViewerScrollOffset);
    screen.render();
    return;
  }
  selectedIndex = Math.max(0, selectedIndex - 1);
  resetDetailScroll();
  render();
});

screen.key(["left"], () => {
  if (actionsViewOpen) {
    focusManualAction(actionsFocusIndex - 1);
    return;
  }
  if (reportViewerOpen) {
    return;
  }
  cycleTab(-1);
});

screen.key(["right"], () => {
  if (actionsViewOpen) {
    focusManualAction(actionsFocusIndex + 1);
    return;
  }
  if (reportViewerOpen) {
    return;
  }
  cycleTab(1);
});

screen.key(["h"], () => {
  if (!actionsViewOpen) {
    return;
  }
  focusManualAction(actionsFocusIndex - 1);
});

screen.key(["x"], () => {
  if (actionsViewOpen) {
    return;
  }
  withSelectedJob((jobId) => {
    const record = repository.getJobRecord(jobId);
    if (canTransition(record.job.status, "rejected")) {
      repository.updateJobStatus(jobId, "rejected");
      setStatusMessage(`Rejected ${record.job.company}`);
      resetDetailScroll();
      table.focus();
      render();
      return;
    }
    setStatusMessage(`Cannot reject from ${record.job.status}`);
    table.focus();
    render();
  });
});

screen.key(["s"], () => {
  if (actionsViewOpen) {
    return;
  }
  withSelectedJob((jobId) => {
    const record = repository.getJobRecord(jobId);
    if (canTransition(record.job.status, "shortlisted")) {
      repository.updateJobStatus(jobId, "shortlisted");
      setStatusMessage(`Shortlisted ${record.job.company}`);
      resetDetailScroll();
      table.focus();
      render();
      return;
    }
    setStatusMessage(`Cannot shortlist from ${record.job.status}`);
    table.focus();
    render();
  });
});

screen.key(["a", "A"], () => {
  if (actionsViewOpen) {
    return;
  }
  withSelectedJob((jobId) => {
    const result = markJobAsApplied(jobId);
    setStatusMessage(result.message);
    if (result.ok) {
      resetDetailScroll();
    }
    table.focus();
    render();
  });
});

screen.key(["i"], () => {
  if (actionsViewOpen) {
    return;
  }
  withSelectedJob((jobId) => {
    const record = repository.getJobRecord(jobId);
    if (canTransition(record.job.status, "blocked")) {
      repository.updateJobStatus(jobId, "blocked");
      setStatusMessage(`Marked ${record.job.company} as interview`);
      resetDetailScroll();
      table.focus();
      render();
      return;
    }
    setStatusMessage(`Cannot move to interview from ${record.job.status}`);
    table.focus();
    render();
  });
});

screen.key(["d"], () => {
  if (actionsViewOpen) {
    return;
  }
  void withSelectedJobAsync(async (jobId) => {
    const company = repository.getJobRecord(jobId).job.company;
    setStatusMessage(`Researching ${company}`);
    render();
    await pipeline.researchCompany(jobId);
    detailView = "research";
    setStatusMessage(`Research updated for ${company}`);
    resetDetailScroll();
    resetReportViewerScroll();
    render();
  });
});

screen.key(["m"], () => {
  if (actionsViewOpen) {
    return;
  }
  void withSelectedJobAsync(async (jobId) => {
    const company = repository.getJobRecord(jobId).job.company;
    setStatusMessage(`Drafting contact for ${company}`);
    render();
    await pipeline.draftContact(jobId);
    detailView = "contact";
    setStatusMessage(`Contact draft updated for ${company}`);
    resetDetailScroll();
    resetReportViewerScroll();
    render();
  });
});

screen.key(["l"], () => {
  if (actionsViewOpen) {
    return;
  }
  void withSelectedJobAsync(async (jobId) => {
    const record = repository.getJobRecord(jobId);
    try {
      await openExternalUrl(record.job.applyUrl);
      setStatusMessage(`Opened ${record.job.company} posting`);
    } catch {
      setStatusMessage(`Failed to open ${record.job.company} posting`);
    }
    render();
  });
});

detail.on("wheelup", () => {
  detailScrollOffset = clampScrollOffset(detail, detailScrollOffset - 3);
  detail.setScroll(detailScrollOffset);
  screen.render();
});

detail.on("wheeldown", () => {
  detailScrollOffset = clampScrollOffset(detail, detailScrollOffset + 3);
  detail.setScroll(detailScrollOffset);
  screen.render();
});

detail.on("click", () => {
  detail.focus();
});

reportViewer.on("wheelup", () => {
  reportViewerScrollOffset = clampScrollOffset(reportViewer, reportViewerScrollOffset - 3);
  reportViewer.setScroll(reportViewerScrollOffset);
  screen.render();
});

reportViewer.on("wheeldown", () => {
  reportViewerScrollOffset = clampScrollOffset(reportViewer, reportViewerScrollOffset + 3);
  reportViewer.setScroll(reportViewerScrollOffset);
  screen.render();
});

reportViewer.on("click", () => {
  reportViewer.focus();
});

actionsButtonsPane.on("wheelup", () => {
  if (!actionsViewOpen) {
    return;
  }
  focusManualAction(actionsFocusIndex - ACTION_BUTTON_COLUMNS);
});

actionsButtonsPane.on("wheeldown", () => {
  if (!actionsViewOpen) {
    return;
  }
  focusManualAction(actionsFocusIndex + ACTION_BUTTON_COLUMNS);
});

actionsOutput.on("wheelup", () => {
  if (!actionsViewOpen) {
    return;
  }
  scrollActionsOutput(-3);
});

actionsOutput.on("wheeldown", () => {
  if (!actionsViewOpen) {
    return;
  }
  scrollActionsOutput(3);
});

actionsOutput.on("click", () => {
  actionsOutput.focus();
});

table.on("select", (_item: unknown, index: number) => {
  if (actionsViewOpen) {
    return;
  }
  if (syncingTableSelection) {
    return;
  }
  selectedIndex = Math.max(0, index - 1);
  resetDetailScroll();
  resetReportViewerScroll();
  render();
});

screen.on("resize", render);

render();
