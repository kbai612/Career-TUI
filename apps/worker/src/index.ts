import { mkdirSync } from "node:fs";
import path from "node:path";
import { chromium, type Page } from "playwright";
import { Command } from "commander";
import PQueue from "p-queue";
import {
  CareerOpsPipeline,
  ensureDataPaths,
  ensureReviewRequired,
  type ApplicationDraft,
  type JobListing,
  type JobRecordWithArtifacts
} from "@career-ops/core";

const rootDir = path.resolve(process.cwd());
const { dbPath, browserProfileDir } = ensureDataPaths(rootDir);
const program = new Command();

function demoJobs(): JobListing[] {
  return [
    {
      portal: "greenhouse",
      sourceUrl: "https://boards.greenhouse.io/example",
      applyUrl: "https://boards.greenhouse.io/example/jobs/1001",
      company: "n8n",
      title: "Staff LLM Interaction Engineer",
      location: "Remote, United States",
      postedAt: new Date().toISOString(),
      compensationText: "$210,000 - $250,000",
      salaryMin: 210000,
      salaryMax: 250000,
      description: "Build agent workflows, evaluation loops, and LLM platform capabilities with TypeScript and automation."
    },
    {
      portal: "lever",
      sourceUrl: "https://jobs.lever.co/example",
      applyUrl: "https://jobs.lever.co/example/1002",
      company: "Zapier",
      title: "Automation Strategist",
      location: "Remote, US",
      compensationText: "$140,000 - $165,000",
      salaryMin: 140000,
      salaryMax: 165000,
      description: "Customer-facing automation role focused on onboarding and enablement."
    },
    {
      portal: "ashby",
      sourceUrl: "https://jobs.ashbyhq.com/example",
      applyUrl: "https://jobs.ashbyhq.com/example/job/1003",
      company: "Grafana Labs",
      title: "Senior Solutions Engineer",
      location: "Remote, United States",
      compensationText: "$190,000 - $220,000",
      salaryMin: 190000,
      salaryMax: 220000,
      description: "Own pre-sales technical discovery, demos, and AI observability workflows."
    }
  ];
}

async function fetchPageHtml(url: string): Promise<string> {
  mkdirSync(browserProfileDir, { recursive: true });
  const context = await chromium.launchPersistentContext(browserProfileDir, {
    channel: "chrome",
    headless: false
  });
  try {
    const page = await context.newPage();
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => undefined);
    return await page.content();
  } finally {
    await context.close();
  }
}

async function fillCommonFields(page: Page, draft: ApplicationDraft): Promise<void> {
  for (const [key, value] of Object.entries(draft.answers) as Array<[string, string]>) {
    const selectors = [
      `[name='${key}']`,
      `[id='${key}']`,
      `[aria-label*='${key.replace(/_/g, " ")}']`
    ];
    for (const selector of selectors) {
      const locator = page.locator(selector).first();
      if (await locator.count()) {
        await locator.fill(value).catch(() => undefined);
        break;
      }
    }
  }
}

program.name("career-ops-worker").description("Career Ops worker CLI");

program
  .command("seed-demo")
  .description("Insert demo jobs into the local database")
  .action(() => {
    const pipeline = new CareerOpsPipeline(rootDir, dbPath);
    try {
      const ids = pipeline.seedDemoJobs(demoJobs());
      console.log(`Seeded ${ids.length} jobs: ${ids.join(", ")}`);
    } finally {
      pipeline.dispose();
    }
  });

program
  .command("scan")
  .description("Scan a careers page URL")
  .argument("<url>")
  .action(async (url: string) => {
    const pipeline = new CareerOpsPipeline(rootDir, dbPath);
    try {
      const html = await fetchPageHtml(url);
      const summary = await pipeline.scanSource(url, html);
      console.log(JSON.stringify(summary, null, 2));
    } finally {
      pipeline.dispose();
    }
  });

program
  .command("evaluate")
  .description("Evaluate pending jobs")
  .option("--limit <count>", "max pending jobs", "25")
  .action(async ({ limit }: { limit: string }) => {
    const pipeline = new CareerOpsPipeline(rootDir, dbPath);
    try {
      const summary = await pipeline.evaluatePending(Number(limit));
      console.log(JSON.stringify(summary, null, 2));
    } finally {
      pipeline.dispose();
    }
  });

program
  .command("evaluate-batch")
  .description("Evaluate pending jobs with bounded parallelism")
  .option("--limit <count>", "max pending jobs", "122")
  .option("--concurrency <count>", "parallel evaluator workers", "6")
  .action(async ({ limit, concurrency }: { limit: string; concurrency: string }) => {
    const pipeline = new CareerOpsPipeline(rootDir, dbPath);
    const queue = new PQueue({ concurrency: Number(concurrency) });
    try {
      const jobs = pipeline.repo.listJobsByStatus(["normalized"]).slice(0, Number(limit));
      await Promise.all(jobs.map((record: JobRecordWithArtifacts) => queue.add(async () => {
        await pipeline.evaluateJob(record.job.id);
      })));
      console.log(`Processed ${jobs.length} jobs with concurrency ${concurrency}`);
    } finally {
      pipeline.dispose();
    }
  });

program
  .command("resume")
  .description("Generate a tailored resume PDF path for a job")
  .argument("<jobId>")
  .action(async (jobId: string) => {
    const pipeline = new CareerOpsPipeline(rootDir, dbPath);
    try {
      const outputPath = await pipeline.generateResume(Number(jobId));
      console.log(outputPath);
    } finally {
      pipeline.dispose();
    }
  });

program
  .command("draft-apply")
  .description("Create a prefilled application draft for review")
  .argument("<jobId>")
  .action(async (jobId: string) => {
    const pipeline = new CareerOpsPipeline(rootDir, dbPath);
    try {
      await pipeline.draftApplication(Number(jobId));
      console.log(`Drafted application for ${jobId}`);
    } finally {
      pipeline.dispose();
    }
  });

program
  .command("review-apply")
  .description("Open a headed browser session and prefill known answers without submitting")
  .argument("<jobId>")
  .action(async (jobId: string) => {
    const pipeline = new CareerOpsPipeline(rootDir, dbPath);
    try {
      const record = pipeline.repo.getJobRecord(Number(jobId));
      if (record.application == null) {
        await pipeline.draftApplication(Number(jobId));
      }
      const refreshed = pipeline.repo.getJobRecord(Number(jobId));
      if (refreshed.job.status === "ready_to_apply") {
        pipeline.repo.updateJobStatus(Number(jobId), "in_review");
      }
      if (refreshed.application == null) {
        throw new Error("Application draft was not created.");
      }
      ensureReviewRequired(refreshed.application);
      mkdirSync(browserProfileDir, { recursive: true });
      const context = await chromium.launchPersistentContext(browserProfileDir, {
        channel: "chrome",
        headless: false
      });
      const page = await context.newPage();
      await page.goto(refreshed.application.targetUrl, { waitUntil: "domcontentloaded" });
      await fillCommonFields(page, refreshed.application);
      console.log("Application prefill complete. Review in the browser and submit manually if desired.");
      console.log("Submission is intentionally blocked by default in this command.");
      await page.pause();
      await context.close();
    } finally {
      pipeline.dispose();
    }
  });

void program.parseAsync(process.argv);
