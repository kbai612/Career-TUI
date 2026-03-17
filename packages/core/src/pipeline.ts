import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { chooseAdapter } from "./adapters";
import { loadArchetypeConfig, loadProfilePack, loadScoringConfig } from "./config";
import { CareerOpsRepository } from "./db";
import { incrementVisitCount, normalizeListing } from "./dedup";
import { OpenAIOrchestrator } from "./llm";
import { applicationDraftSchema, evaluationReportSchema } from "./schema";
import { buildApplicationDraft } from "./application";
import { buildResumeVariant, renderResumePdf } from "./resume";
import type { EvaluationReport, JobListing, RunSummary } from "./types";

export class CareerOpsPipeline {
  readonly repo: CareerOpsRepository;
  private readonly rootDir: string;
  private readonly orchestrator: OpenAIOrchestrator;

  constructor(rootDir: string, dbPath: string) {
    this.rootDir = rootDir;
    this.repo = new CareerOpsRepository(dbPath);
    this.orchestrator = new OpenAIOrchestrator();
    mkdirSync(path.resolve(rootDir, "data", "resumes"), { recursive: true });
  }

  dispose(): void {
    this.repo.close();
  }

  async scanSource(sourceUrl: string, html: string): Promise<RunSummary> {
    const startedAt = new Date().toISOString();
    const adapter = chooseAdapter(sourceUrl);
    const listings = adapter.discoverListings(html, sourceUrl);
    let created = 0;
    for (const listing of listings) {
      const normalized = normalizeListing({ ...listing, description: listing.description ?? "" }, "normalized");
      this.repo.upsertJob(normalized);
      created += 1;
    }
    const summary: RunSummary = {
      mode: "scanner-discovery",
      startedAt,
      completedAt: new Date().toISOString(),
      processed: listings.length,
      created,
      updated: 0,
      errors: []
    };
    this.repo.saveRunSummary(summary);
    return summary;
  }

  async evaluateJob(jobId: number): Promise<void> {
    const scoring = loadScoringConfig(this.rootDir);
    const archetypes = loadArchetypeConfig(this.rootDir).archetypes;
    const profile = loadProfilePack(this.rootDir);
    const record = this.repo.getJobRecord(jobId);
    const normalized = JSON.parse(record.job.normalizedJson) as JobListing;
    const nextVisits = incrementVisitCount(record.job.visitCount);
    this.repo.setVisitCount(record.job.id, nextVisits);
    const report = await this.orchestrator.runStructured(
      "offer-evaluator",
      normalized,
      evaluationReportSchema,
      { archetypes, scoring, profile }
    ) as EvaluationReport;
    report.jobId = record.job.id;
    this.repo.saveEvaluation(record.job.id, report);
    this.repo.updateJobStatus(record.job.id, report.recommendedAction === "reject" ? "rejected" : "evaluated");
    if (report.recommendedAction === "apply") {
      this.repo.updateJobStatus(record.job.id, "shortlisted");
    }
  }

  async evaluatePending(limit = 25): Promise<RunSummary> {
    const startedAt = new Date().toISOString();
    const pending = this.repo.listJobsByStatus(["normalized"]).slice(0, limit);
    for (const record of pending) {
      await this.evaluateJob(record.job.id);
    }
    const summary: RunSummary = {
      mode: "offer-evaluator",
      startedAt,
      completedAt: new Date().toISOString(),
      processed: pending.length,
      created: 0,
      updated: pending.length,
      errors: []
    };
    this.repo.saveRunSummary(summary);
    return summary;
  }

  async generateResume(jobId: number): Promise<string> {
    const profile = loadProfilePack(this.rootDir);
    const record = this.repo.getJobRecord(jobId);
    if (record.evaluation == null) {
      throw new Error(`Job ${jobId} has not been evaluated.`);
    }
    const normalized = JSON.parse(record.job.normalizedJson) as JobListing;
    const variant = buildResumeVariant(
      jobId,
      path.resolve(this.rootDir, "data", "resumes"),
      normalized,
      record.evaluation,
      profile
    );
    try {
      await renderResumePdf(variant);
    } catch {
      // Keep the HTML artifact when the environment blocks browser launch.
    }
    this.repo.saveResume(jobId, variant);
    if (record.job.status === "shortlisted") {
      this.repo.updateJobStatus(jobId, "resume_ready");
    }
    return existsSync(variant.pdfPath) ? variant.pdfPath : variant.htmlPath;
  }

  async draftApplication(jobId: number): Promise<void> {
    const profile = loadProfilePack(this.rootDir);
    const record = this.repo.getJobRecord(jobId);
    if (record.evaluation == null) {
      throw new Error(`Job ${jobId} is missing evaluation data.`);
    }
    const normalized = JSON.parse(record.job.normalizedJson) as JobListing;
    const draft = buildApplicationDraft(jobId, normalized, record.evaluation, profile);
    applicationDraftSchema.parse(draft);
    this.repo.saveApplicationDraft(jobId, draft);
    if (record.job.status === "resume_ready") {
      this.repo.updateJobStatus(jobId, "ready_to_apply");
    }
  }

  seedDemoJobs(jobs: JobListing[]): number[] {
    return jobs.map((job) => this.repo.upsertJob(normalizeListing(job, "normalized")));
  }
}
