import { existsSync, mkdirSync } from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { chooseAdapter, extractDirectListing } from "./adapters";
import { loadArchetypeConfig, loadProfilePack, loadRegionConfig, loadScoringConfig } from "./config";
import { CareerOpsRepository } from "./db";
import { enrichDiscoveredListing, filterListingsByRegion } from "./discovery";
import { incrementVisitCount, normalizeListing } from "./dedup";
import { OpenAIOrchestrator } from "./llm";
import { canTransition } from "./state-machine";
import {
  applicationDraftSchema,
  contactDraftSchema,
  deepResearchReportSchema,
  evaluationReportSchema,
  offerComparisonSchema,
  trainingAssessmentSchema
} from "./schema";
import { buildApplicationDraft } from "./application";
import { buildResumeVariant, renderResumePdf } from "./resume";
import { isRichEvaluationReport } from "./scoring";
import type {
  CareerSource,
  ContactDraft,
  DeepResearchReport,
  EvaluationReport,
  JobListing,
  OfferComparison,
  RegionRule,
  RunSummary,
  SourceSyncRun,
  TrainingAssessment
} from "./types";

const DEFAULT_TARGETED_TITLE_KEYWORDS = [
  "senior data analyst",
  "analytics engineer",
  "data engineer",
  "analyst",
  "scientist",
  "analytics",
  "business intelligence",
  "machine learning",
  "experimentation",
  "statistician"
];

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

  private getContext(): { scoring: ReturnType<typeof loadScoringConfig>; archetypes: ReturnType<typeof loadArchetypeConfig>["archetypes"]; profile: ReturnType<typeof loadProfilePack> } {
    return {
      scoring: loadScoringConfig(this.rootDir),
      archetypes: loadArchetypeConfig(this.rootDir).archetypes,
      profile: loadProfilePack(this.rootDir)
    };
  }

  private getRegionRule(regionId: string): RegionRule {
    const regions = loadRegionConfig(this.rootDir).regions;
    const match = regions.find((region) => region.id === regionId);
    if (match == null) {
      throw new Error(`Unknown region id ${regionId}`);
    }
    return match;
  }

  private keywordMatches(haystack: string, keyword: string): boolean {
    const escaped = keyword
      .trim()
      .toLowerCase()
      .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
      .replace(/\s+/g, "\\s+");
    if (!escaped) {
      return false;
    }
    const pattern = new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, "i");
    return pattern.test(haystack);
  }

  private inferLocationFromSourceUrl(sourceUrl: string): string | undefined {
    try {
      const parsed = new URL(sourceUrl);
      for (const key of ["l", "location", "where"]) {
        const value = parsed.searchParams.get(key)?.trim();
        if (value && value.length > 0) {
          return value.replace(/\+/g, " ");
        }
      }
      const segments = parsed.pathname.split("/").filter(Boolean);
      const locationSegmentIndex = segments.findIndex((segment) => segment.toLowerCase() === "location");
      if (locationSegmentIndex >= 0 && segments[locationSegmentIndex + 1]) {
        return decodeURIComponent(segments[locationSegmentIndex + 1]).replace(/-/g, " ");
      }
    } catch {
      return undefined;
    }
    return undefined;
  }

  private needsLocationFallback(location: string | undefined): boolean {
    if (location == null) {
      return true;
    }
    const normalized = location.trim().toLowerCase();
    return normalized.length === 0 || normalized === "unknown" || normalized === "n/a";
  }

  private extractListings(sourceUrl: string, html: string, source?: CareerSource): { listings: JobListing[]; rawCount: number } {
    const adapter = chooseAdapter(sourceUrl, source?.kind);
    const discovered = adapter.discoverListings(html, sourceUrl);
    const listings = discovered.length > 0
      ? discovered
      : [extractDirectListing(html, sourceUrl, adapter.portal)].filter(Boolean) as JobListing[];
    const defaultRoleKeywords = source?.kind === "greenhouse" || source?.kind === "lever"
      ? DEFAULT_TARGETED_TITLE_KEYWORDS
      : [];
    const titleKeywords = Array.isArray(source?.metadata?.titleKeywords)
      ? source?.metadata?.titleKeywords.filter((keyword): keyword is string => typeof keyword === "string" && keyword.trim().length > 0)
      : defaultRoleKeywords;
    const configuredMaxAgeHours = typeof source?.metadata?.maxAgeHours === "number" && Number.isFinite(source.metadata.maxAgeHours) && source.metadata.maxAgeHours > 0
      ? source.metadata.maxAgeHours
      : undefined;
    const maxAgeHours = configuredMaxAgeHours
      ?? ((source?.kind === "greenhouse" || source?.kind === "lever" || source?.kind === "linkedin") ? 24 : undefined);
    const recencyFilteredListings = maxAgeHours == null
      ? listings
      : listings.filter((listing) => {
          if (listing.postedAt == null) {
            return true;
          }
          const postedTimestamp = Date.parse(listing.postedAt);
          if (!Number.isFinite(postedTimestamp)) {
            return true;
          }
          return postedTimestamp >= Date.now() - (maxAgeHours * 60 * 60 * 1000);
        });
    const shouldApplyTitleKeywords = titleKeywords.length > 0 && source?.kind !== "levels";
    const filteredListings = shouldApplyTitleKeywords
      ? recencyFilteredListings.filter((listing) => {
          const haystack = `${listing.title} ${listing.description ?? ""}`.toLowerCase();
          return titleKeywords.some((keyword) => this.keywordMatches(haystack, keyword));
        })
      : recencyFilteredListings;
    const effectiveListings = filteredListings.length === 0
      && listings.length > 0
      && source?.metadata?.discoveryOnly === true
      ? listings
      : filteredListings;
    const fallbackLocation = this.inferLocationFromSourceUrl(source?.sourceUrl ?? sourceUrl);
    const enrichedListings = effectiveListings.map((listing) => enrichDiscoveredListing({
      ...listing,
      location: this.needsLocationFallback(listing.location)
        ? (fallbackLocation ?? "Unknown")
        : listing.location.trim(),
      description: listing.description ?? "",
      rawHtml: listing.rawHtml ?? html
    }, source));

    return {
      rawCount: listings.length,
      listings: enrichedListings
    };
  }

  registerSource(source: CareerSource): number {
    return this.repo.upsertCareerSource(source);
  }

  seedTorontoDiscoverySources(): number[] {
    const legacyDefaultSourceUrls = new Set<string>([
      "https://boards.greenhouse.io/embed/job_board?for=stripe",
      "https://jobs.lever.co/shyftlabs?location=Toronto%2C+Ontario",
      "https://jobs.lever.co/caseware"
    ]);
    const targetedTitleKeywords = DEFAULT_TARGETED_TITLE_KEYWORDS;
    const levelsRoleSources = [
      {
        name: "Levels Toronto Data Analyst",
        sourceUrl: "https://www.levels.fyi/jobs/location/greater-toronto-area?searchText=Data%20Analyst",
        kind: "levels" as const,
        regionId: "toronto-canada",
        active: true,
        usePersistentBrowser: false,
        metadata: { role: "data-analyst", discoveryOnly: true, titleKeywords: targetedTitleKeywords }
      },
      {
        name: "Levels Toronto Senior Data Analyst",
        sourceUrl: "https://www.levels.fyi/jobs/location/greater-toronto-area?searchText=Senior%20Data%20Analyst",
        kind: "levels" as const,
        regionId: "toronto-canada",
        active: true,
        usePersistentBrowser: false,
        metadata: { role: "senior-data-analyst", discoveryOnly: true, titleKeywords: targetedTitleKeywords }
      },
      {
        name: "Levels Toronto Analytics Engineer",
        sourceUrl: "https://www.levels.fyi/jobs/location/greater-toronto-area?searchText=Analytics%20Engineer",
        kind: "levels" as const,
        regionId: "toronto-canada",
        active: true,
        usePersistentBrowser: false,
        metadata: { role: "analytics-engineer", discoveryOnly: true, titleKeywords: targetedTitleKeywords }
      },
      {
        name: "Levels Toronto Data Scientist",
        sourceUrl: "https://www.levels.fyi/jobs/location/greater-toronto-area?searchText=Data%20Scientist",
        kind: "levels" as const,
        regionId: "toronto-canada",
        active: true,
        usePersistentBrowser: false,
        metadata: { role: "data-scientist", discoveryOnly: true, titleKeywords: targetedTitleKeywords }
      }
    ];
    const isLegacyLevelsTorontoSource = (sourceUrl: string): boolean => {
      try {
        const parsed = new URL(sourceUrl);
        if (!/levels\.fyi$/i.test(parsed.hostname.replace(/^www\./, ""))) {
          return false;
        }

        const pathname = parsed.pathname.toLowerCase();
        const searchText = parsed.searchParams.get("searchText")?.trim().toLowerCase() ?? "";
        const isGenericSearchText = searchText.length === 0 || searchText === "data";

        const isLegacyJobsSearch = /^\/jobs\/?$/.test(pathname)
          && (parsed.searchParams.get("location")?.toLowerCase().includes("toronto") ?? false)
          && isGenericSearchText;
        const isLegacyLocationSearch = /^\/jobs\/location\/greater-toronto-area\/?$/.test(pathname)
          && isGenericSearchText;

        return isLegacyJobsSearch || isLegacyLocationSearch;
      } catch {
        return false;
      }
    };

    for (const source of this.listSources({ activeOnly: false, regionId: "toronto-canada" })) {
      const shouldDeactivateLegacy = legacyDefaultSourceUrls.has(source.sourceUrl)
        || isLegacyLevelsTorontoSource(source.sourceUrl);
      if (!shouldDeactivateLegacy || source.active === false) {
        continue;
      }
      this.registerSource({
        name: source.name,
        sourceUrl: source.sourceUrl,
        kind: source.kind,
        regionId: source.regionId,
        active: false,
        usePersistentBrowser: source.usePersistentBrowser,
        metadata: source.metadata
      });
    }

    return [
      {
        name: "LinkedIn Toronto Data Analyst",
        sourceUrl: "https://www.linkedin.com/jobs/search/?keywords=Data%20Analyst&location=Toronto%2C%20Ontario%2C%20Canada&f_TPR=r86400",
        kind: "linkedin" as const,
        regionId: "toronto-canada",
        active: true,
        usePersistentBrowser: false,
        metadata: { role: "data-analyst", discoveryOnly: true, titleKeywords: targetedTitleKeywords }
      },
      {
        name: "LinkedIn Toronto Senior Data Analyst",
        sourceUrl: "https://www.linkedin.com/jobs/search/?keywords=Senior%20Data%20Analyst&location=Toronto%2C%20Ontario%2C%20Canada&f_TPR=r86400",
        kind: "linkedin" as const,
        regionId: "toronto-canada",
        active: true,
        usePersistentBrowser: false,
        metadata: { role: "senior-data-analyst", discoveryOnly: true, titleKeywords: targetedTitleKeywords }
      },
      {
        name: "LinkedIn Toronto Analytics Engineer",
        sourceUrl: "https://www.linkedin.com/jobs/search/?keywords=Analytics%20Engineer&location=Toronto%2C%20Ontario%2C%20Canada&f_TPR=r86400",
        kind: "linkedin" as const,
        regionId: "toronto-canada",
        active: true,
        usePersistentBrowser: false,
        metadata: { role: "analytics-engineer", discoveryOnly: true, titleKeywords: targetedTitleKeywords }
      },
      {
        name: "LinkedIn Toronto Data Scientist",
        sourceUrl: "https://www.linkedin.com/jobs/search/?keywords=Data%20Scientist&location=Toronto%2C%20Ontario%2C%20Canada&f_TPR=r86400",
        kind: "linkedin" as const,
        regionId: "toronto-canada",
        active: true,
        usePersistentBrowser: false,
        metadata: { role: "data-scientist", discoveryOnly: true, titleKeywords: targetedTitleKeywords }
      },
      ...levelsRoleSources,
      {
        name: "Workopolis Toronto Data Jobs",
        sourceUrl: "https://www.workopolis.com/jobsearch/find-jobs?ak=Data+Analyst+OR+Senior+Data+Analyst+OR+Analytics+Engineer+OR+Data+Scientist&l=Toronto%2C+ON",
        kind: "generic" as const,
        regionId: "toronto-canada",
        active: true,
        usePersistentBrowser: false,
        metadata: {
          role: "data",
          discoveryOnly: true,
          titleKeywords: targetedTitleKeywords
        }
      },
      {
        name: "Indeed Canada Toronto Data Jobs",
        sourceUrl: "https://ca.indeed.com/jobs?q=Data+Analyst+OR+Senior+Data+Analyst+OR+Analytics+Engineer+OR+Data+Scientist&l=Toronto%2C+ON",
        kind: "generic" as const,
        regionId: "toronto-canada",
        active: true,
        usePersistentBrowser: false,
        metadata: {
          role: "data",
          discoveryOnly: true,
          titleKeywords: targetedTitleKeywords
        }
      },
      {
        name: "SimplyHired Canada Toronto Data Jobs",
        sourceUrl: "https://www.simplyhired.ca/search?q=Data+Analyst+OR+Senior+Data+Analyst+OR+Analytics+Engineer+OR+Data+Scientist&l=Toronto%2C+ON",
        kind: "generic" as const,
        regionId: "toronto-canada",
        active: true,
        usePersistentBrowser: false,
        metadata: {
          role: "data",
          discoveryOnly: true,
          titleKeywords: targetedTitleKeywords
        }
      }
    ].map((source) => this.registerSource(source));
  }

  listSources(options: { activeOnly?: boolean; regionId?: string } = {}): ReturnType<CareerOpsRepository["listCareerSources"]> {
    return this.repo.listCareerSources(options);
  }

  async scanSource(sourceUrl: string, html: string, options: { source?: CareerSource; regionId?: string; persistRun?: boolean } = {}): Promise<RunSummary> {
    const startedAt = new Date().toISOString();
    const extracted = this.extractListings(sourceUrl, html, options.source);
    const filteredListings = options.regionId
      ? filterListingsByRegion(extracted.listings, this.getRegionRule(options.regionId))
      : extracted.listings;
    const jobIds: number[] = [];
    for (const listing of filteredListings) {
      const normalized = normalizeListing(listing, "normalized");
      const jobId = this.repo.upsertJob(normalized);
      jobIds.push(jobId);
    }
    const summary: RunSummary = {
      mode: "scanner-discovery",
      startedAt,
      completedAt: new Date().toISOString(),
      processed: filteredListings.length,
      created: filteredListings.length,
      updated: 0,
      errors: extracted.rawCount === 0 ? [`No listings extracted from ${sourceUrl}`] : [],
      jobIds
    };
    if (options.persistRun ?? true) {
      this.repo.saveRunSummary(summary);
    }
    return summary;
  }

  async syncRegisteredSource(sourceId: number, html: string): Promise<SourceSyncRun> {
    const source = this.repo.getCareerSource(sourceId);
    const startedAt = new Date().toISOString();
    try {
      const scanSummary = await this.scanSource(source.sourceUrl, html, { source, regionId: source.regionId, persistRun: false });
      const run: SourceSyncRun = {
        sourceId: source.id,
        sourceName: source.name,
        sourceUrl: source.sourceUrl,
        regionId: source.regionId,
        startedAt,
        completedAt: new Date().toISOString(),
        processed: scanSummary.processed,
        created: scanSummary.created,
        updated: scanSummary.updated,
        errors: scanSummary.errors,
        status: scanSummary.errors.length > 0 && scanSummary.processed === 0 ? "error" : "success",
        jobIds: scanSummary.jobIds ?? []
      };
      this.repo.updateCareerSourceSync(source.id, run.status, run.completedAt);
      this.repo.saveSourceSyncRun(run);
      return run;
    } catch (error) {
      const completedAt = new Date().toISOString();
      const run: SourceSyncRun = {
        sourceId: source.id,
        sourceName: source.name,
        sourceUrl: source.sourceUrl,
        regionId: source.regionId,
        startedAt,
        completedAt,
        processed: 0,
        created: 0,
        updated: 0,
        errors: [error instanceof Error ? error.message : String(error)],
        status: "error",
        jobIds: []
      };
      this.repo.updateCareerSourceSync(source.id, "error", completedAt);
      this.repo.saveSourceSyncRun(run);
      return run;
    }
  }

  async evaluateJob(jobId: number): Promise<EvaluationReport> {
    const { scoring, archetypes, profile } = this.getContext();
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
    const baseStatus = report.recommendedAction === "reject" ? "rejected" : "evaluated";
    if (canTransition(record.job.status, baseStatus)) {
      this.repo.updateJobStatus(record.job.id, baseStatus);
    }
    if (report.recommendedAction === "apply" && canTransition(this.repo.getJobRecord(record.job.id).job.status, "shortlisted")) {
      this.repo.updateJobStatus(record.job.id, "shortlisted");
    }
    return report;
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
      errors: [],
      jobIds: pending.map((record) => record.job.id)
    };
    this.repo.saveRunSummary(summary);
    return summary;
  }

  async ensureEvaluation(jobId: number): Promise<EvaluationReport> {
    const record = this.repo.getJobRecord(jobId);
    return record.evaluation != null && isRichEvaluationReport(record.evaluation)
      ? record.evaluation
      : this.evaluateJob(jobId);
  }

  async generateOfferReport(jobId: number): Promise<EvaluationReport> {
    return this.ensureEvaluation(jobId);
  }

  async compareOffers(jobIds: number[]): Promise<OfferComparison> {
    const { scoring, archetypes, profile } = this.getContext();
    const payload = await Promise.all(jobIds.map(async (jobId) => {
      const record = this.repo.getJobRecord(jobId);
      const report = await this.ensureEvaluation(jobId);
      return {
        jobId,
        company: record.job.company,
        title: record.job.title,
        report
      };
    }));

    return this.orchestrator.runStructured(
      "offer-comparison",
      payload,
      offerComparisonSchema,
      { archetypes, scoring, profile }
    ) as Promise<OfferComparison>;
  }

  async generateResume(jobId: number): Promise<string> {
    const profile = loadProfilePack(this.rootDir);
    const record = this.repo.getJobRecord(jobId);
    const report = record.evaluation ?? await this.evaluateJob(jobId);
    const normalized = JSON.parse(record.job.normalizedJson) as JobListing;
    const variant = buildResumeVariant(
      jobId,
      path.resolve(this.rootDir, "data", "resumes"),
      normalized,
      report,
      profile
    );
    try {
      await renderResumePdf(variant);
    } catch {
      // Keep the HTML artifacts when the environment blocks browser launch.
    }
    this.repo.saveResume(jobId, variant);
    if (record.job.status === "shortlisted" || record.job.status === "evaluated") {
      this.repo.updateJobStatus(jobId, "resume_ready");
    }
    return existsSync(variant.pdfPath) ? variant.pdfPath : variant.htmlPath;
  }

  async draftApplication(jobId: number): Promise<void> {
    const profile = loadProfilePack(this.rootDir);
    const record = this.repo.getJobRecord(jobId);
    const report = record.evaluation ?? await this.evaluateJob(jobId);
    const normalized = JSON.parse(record.job.normalizedJson) as JobListing;
    const draft = buildApplicationDraft(jobId, normalized, report, profile);
    applicationDraftSchema.parse(draft);
    this.repo.saveApplicationDraft(jobId, draft);
    const refreshed = this.repo.getJobRecord(jobId);
    if (refreshed.job.status === "resume_ready") {
      this.repo.updateJobStatus(jobId, "ready_to_apply");
    }
  }

  async researchCompany(jobId: number): Promise<DeepResearchReport> {
    const { scoring, archetypes, profile } = this.getContext();
    const record = this.repo.getJobRecord(jobId);
    const report = record.evaluation ?? await this.evaluateJob(jobId);
    const normalized = JSON.parse(record.job.normalizedJson) as JobListing;
    const research = await this.orchestrator.runStructured(
      "company-research",
      { jobId, job: normalized, report },
      deepResearchReportSchema,
      { archetypes, scoring, profile }
    ) as DeepResearchReport;
    this.repo.saveResearch(jobId, research);
    return research;
  }

  async draftContact(jobId: number): Promise<ContactDraft> {
    const { scoring, archetypes, profile } = this.getContext();
    const record = this.repo.getJobRecord(jobId);
    const report = record.evaluation ?? await this.evaluateJob(jobId);
    const normalized = JSON.parse(record.job.normalizedJson) as JobListing;
    const draft = await this.orchestrator.runStructured(
      "contact-drafter",
      { jobId, job: normalized, report },
      contactDraftSchema,
      { archetypes, scoring, profile }
    ) as ContactDraft;
    this.repo.saveContactDraft(jobId, draft);
    return draft;
  }

  async assessTraining(source: string): Promise<TrainingAssessment> {
    const { scoring, archetypes, profile } = this.getContext();
    const assessment = await this.orchestrator.runStructured(
      "training-evaluator",
      { source },
      trainingAssessmentSchema,
      { archetypes, scoring, profile }
    ) as TrainingAssessment;
    const sourceKey = crypto.createHash("sha256").update(source.trim().toLowerCase()).digest("hex");
    this.repo.saveTrainingAssessment(sourceKey, assessment);
    return assessment;
  }

  async runAutoPipeline(sourceUrl: string, html: string): Promise<{ jobIds: number[]; evaluations: number; resumes: string[]; drafts: number; rejected: number }> {
    const startedAt = new Date().toISOString();
    const scanSummary = await this.scanSource(sourceUrl, html);
    const resumes: string[] = [];
    let evaluations = 0;
    let drafts = 0;
    let rejected = 0;

    for (const jobId of scanSummary.jobIds ?? []) {
      const report = await this.evaluateJob(jobId);
      evaluations += 1;
      if (report.recommendedAction === "reject") {
        rejected += 1;
        continue;
      }
      resumes.push(await this.generateResume(jobId));
      if (report.recommendedAction === "apply") {
        await this.draftApplication(jobId);
        drafts += 1;
      }
    }

    const result = {
      jobIds: scanSummary.jobIds ?? [],
      evaluations,
      resumes,
      drafts,
      rejected
    };
    this.repo.saveRunSummary({
      mode: "auto-pipeline",
      startedAt,
      completedAt: new Date().toISOString(),
      processed: result.jobIds.length,
      created: result.jobIds.length,
      updated: evaluations,
      errors: [],
      jobIds: result.jobIds
    });
    return result;
  }

  seedDemoJobs(jobs: JobListing[]): number[] {
    return jobs.map((job) => this.repo.upsertJob(normalizeListing(job, "normalized")));
  }
}
