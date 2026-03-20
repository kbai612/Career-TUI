import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApplicationDraft, ensureReviewRequired } from "../src/application";
import { ashbyAdapter, genericCareersAdapter, greenhouseAdapter, leverAdapter, levelsAdapter, linkedinAdapter, workdayAdapter } from "../src/adapters";
import { loadArchetypeConfig, loadProfilePack, loadRegionConfig, loadScoringConfig } from "../src/config";
import { buildFingerprint, incrementVisitCount } from "../src/dedup";
import { canonicalizeUrl, filterListingsByRegion } from "../src/discovery";
import { CareerOpsPipeline } from "../src/pipeline";
import { buildResumeVariant } from "../src/resume";
import {
  applicationDraftSchema,
  contactDraftSchema,
  deepResearchReportSchema,
  evaluationReportSchema,
  offerComparisonSchema,
  trainingAssessmentSchema,
  validateAgentOutput
} from "../src/schema";
import {
  buildDeepResearchReport,
  buildOfferComparison,
  buildOutreachDraft,
  buildTrainingAssessment,
  deterministicEvaluation,
  matchArchetype,
  recommendationForScore,
  scoreToGrade
} from "../src/scoring";
import { assertTransition, canTransition } from "../src/state-machine";

const rootDir = path.resolve(__dirname, "..", "..", "..");
const readFixture = (name: string) => readFileSync(path.resolve(__dirname, "fixtures", name), "utf8");

describe("scoring and state", () => {
  const scoring = loadScoringConfig(rootDir);
  const archetypes = loadArchetypeConfig(rootDir).archetypes;
  const profile = loadProfilePack(rootDir);
  const job = {
    portal: "greenhouse",
    sourceUrl: "https://boards.greenhouse.io/example",
    applyUrl: "https://boards.greenhouse.io/example/jobs/123",
    company: "Acme Analytics",
    title: "Senior Data Scientist",
    location: "Toronto, Ontario, Canada",
    description: "Python pandas statistics experimentation forecasting regression classification causal inference feature engineering SQL A/B testing dashboard analytics.",
    salaryMin: 190000,
    salaryMax: 220000
  };

  it("builds stable fingerprints and enforces visit ceiling", () => {
    const one = buildFingerprint(job);
    const two = buildFingerprint({ ...job });
    expect(one).toBe(two);
    expect(() => incrementVisitCount(2)).toThrow(/Visited twice max/);
  });

  it("matches archetypes and recommendations", () => {
    const archetype = matchArchetype(job, archetypes);
    expect(archetype.id).toBe("data-scientist");
    expect(recommendationForScore(4.2, scoring)).toBe("apply");
    expect(scoreToGrade(4.2)).toBe("B");
  });

  it("computes deterministic evaluations with the richer report shape", () => {
    const report = deterministicEvaluation(job, archetypes, scoring, profile);
    expect(report.totalScore).toBeGreaterThan(3.7);
    expect(report.recommendedAction).toBe("apply");
    expect(report.cvMatches.length).toBeGreaterThan(0);
    expect(report.personalization.keywords.length).toBeGreaterThan(0);
    expect(report.interviewView.likelihood).toBeGreaterThan(0);
  });

  it("guards state transitions", () => {
    expect(canTransition("normalized", "evaluated")).toBe(true);
    expect(canTransition("evaluated", "resume_ready")).toBe(true);
    expect(() => assertTransition("discovered", "submitted")).toThrow(/Invalid state transition/);
  });
});

describe("schemas, adapters, resume, and derived artifacts", () => {
  const scoring = loadScoringConfig(rootDir);
  const archetypes = loadArchetypeConfig(rootDir).archetypes;
  const profile = loadProfilePack(rootDir);
  const job = {
    portal: "generic",
    sourceUrl: "https://example.com",
    applyUrl: "https://example.com/job",
    company: "Acme",
    title: "Senior Data Analyst",
    location: "Toronto, Ontario, Canada",
    description: "SQL Tableau Power BI dashboard KPI stakeholder reporting A/B testing experimentation business insights"
  };

  it("validates evaluator schema", () => {
    const report = deterministicEvaluation(job, archetypes, scoring, profile);
    expect(validateAgentOutput(evaluationReportSchema, report).summary).toContain("scores");
  });

  it("parses supported portal fixtures", () => {
    const greenhouseListings = greenhouseAdapter.discoverListings(readFixture("greenhouse.html"), "https://boards.greenhouse.io/example");
    const leverListings = leverAdapter.discoverListings(readFixture("lever.html"), "https://jobs.lever.co/example");
    const workdayListings = workdayAdapter.discoverListings(readFixture("workday.html"), "https://company.workdayjobs.com/example");

    expect(greenhouseListings.length).toBe(1);
    expect(greenhouseListings[0]?.compensationText).toBeUndefined();
    expect(leverListings[0]?.title).toContain("Solutions");
    expect(leverListings[0]?.compensationText).toBeUndefined();
    expect(ashbyAdapter.discoverListings(readFixture("ashby.html"), "https://jobs.ashbyhq.com/example")[0]?.company).toContain("jobs.ashbyhq.com");
    expect(workdayListings.length).toBe(1);
    expect(workdayListings[0]?.compensationText).toBeUndefined();
    expect(genericCareersAdapter.discoverListings(readFixture("generic.html"), "https://company.com/careers")[0]?.salaryMin).toBe(200000);
  });

  it("parses linkedin and levels discovery pages and preserves canonical URLs", () => {
    const linkedinHtml = `
      <div class="base-search-card">
        <a class="base-card__full-link" href="/jobs/view/123?trk=public_jobs_jobs-search-bar_search-submit&refId=abc">View</a>
        <h3 class="base-search-card__title">Senior Data Analyst</h3>
        <h4 class="base-search-card__subtitle">Northwind Analytics</h4>
        <span class="job-search-card__location">Toronto, Ontario, Canada</span>
      </div>
    `;
    const levelsNextData = JSON.stringify({
      props: {
        pageProps: {
          initialJobsData: {
            results: [
              {
                companyName: "Acme AI",
                shortDescription: "Applied AI company",
                jobs: [
                  {
                    id: "456",
                    title: "Data Scientist",
                    locations: ["Toronto, ON"],
                    applicationUrl: "https://boards.greenhouse.io/acme/jobs/456?gh_jid=456&utm_source=levels",
                    postingDate: "2026-03-18T00:00:00.000Z",
                    minBaseSalary: 180000,
                    maxBaseSalary: 210000,
                    baseSalaryCurrency: "USD"
                  }
                ]
              }
            ]
          }
        }
      }
    });
    const levelsHtml = `<script id="__NEXT_DATA__" type="application/json">${levelsNextData}</script>`;

    const linkedinListing = linkedinAdapter.discoverListings(linkedinHtml, "https://www.linkedin.com/jobs/search/?keywords=Data%20Analyst")[0];
    const levelsListing = levelsAdapter.discoverListings(levelsHtml, "https://www.levels.fyi/jobs/?location=Toronto")[0];

    expect(linkedinListing.applyUrl).toBe("https://www.linkedin.com/jobs/view/123");
    expect(levelsListing.applyUrl).toBe("https://boards.greenhouse.io/acme/jobs/456");
    expect(levelsListing.salaryMin).toBe(180000);
    expect(levelsListing.company).toBe("Acme AI");
  });

  it("parses levels location pages with inline Toronto job cards", () => {
    const levelsHtml = `
      <div role="button" class="company-jobs-preview-card-module-scss-module__abc__container">
        <div class="company-jobs-preview-card-module-scss-module__abc__companyHeaderTextContainer">
          <h2 class="company-jobs-preview-card-module-scss-module__abc__companyName">CGI</h2>
          <div class="company-jobs-preview-card-module-scss-module__abc__shortDescription">IT consulting and services.</div>
        </div>
        <div class="company-jobs-preview-card-module-scss-module__abc__companyJobsContainer">
          <a href="/jobs?jobId=81795776815997638">
            <div class="company-jobs-preview-card-module-scss-module__abc__companyJobTitle">Senior Big Data Engineering <span>16 days ago</span></div>
            <div class="company-jobs-preview-card-module-scss-module__abc__companyJobLocation">Toronto, Ontario, Canada · Hybrid · $95K - $145K</div>
          </a>
          <a href="/jobs?jobId=133532090648928966">
            <div class="company-jobs-preview-card-module-scss-module__abc__companyJobTitle">Sr. Business Analyst (AML / Financial Crime) <span>3 months ago</span></div>
            <div class="company-jobs-preview-card-module-scss-module__abc__companyJobLocation">Toronto, Ontario, Canada · Hybrid · $80K - $130K</div>
          </a>
        </div>
      </div>
    `;

    const listings = levelsAdapter.discoverListings(levelsHtml, "https://www.levels.fyi/jobs/location/greater-toronto-area");

    expect(listings).toHaveLength(2);
    expect(listings[0]?.company).toBe("CGI");
    expect(listings[0]?.compensationText).toBe("$95K - $145K");
    expect(listings[0]?.salaryMin).toBe(95000);
    expect(listings[1]?.title).toContain("Business Analyst");
    expect(listings[1]?.applyUrl).toBe("https://www.levels.fyi/jobs?jobId=133532090648928966");
  });

  it("builds ATS-safe resume variants with cover letters", () => {
    const report = deterministicEvaluation(job, archetypes, scoring, profile);
    const variant = buildResumeVariant(1, path.resolve(rootDir, "data", "test-resumes"), job, report, profile);
    expect(variant.html).toContain("<html>");
    expect(variant.plainText).toContain("Senior Data Analyst");
    expect(variant.coverLetterHtml).toContain("Cover Letter");
  });

  it("builds review-required application drafts", () => {
    const report = deterministicEvaluation(job, archetypes, scoring, profile);
    const draft = buildApplicationDraft(1, job, report, profile);
    ensureReviewRequired(draft);
    expect(validateAgentOutput(applicationDraftSchema, draft).reviewRequired).toBe(true);
  });

  it("builds comparison, deep research, contact, and training outputs", () => {
    const report = deterministicEvaluation(job, archetypes, scoring, profile);
    const comparison = buildOfferComparison([{ jobId: 1, company: job.company, title: job.title, report }]);
    const research = buildDeepResearchReport(1, job, report, profile);
    const contact = buildOutreachDraft(1, job, report, profile);
    const training = buildTrainingAssessment("Advanced analytics experimentation and forecasting", archetypes, profile);

    expect(validateAgentOutput(offerComparisonSchema, comparison).ranking[0]?.jobId).toBe(1);
    expect(validateAgentOutput(deepResearchReportSchema, research).company).toBe("Acme");
    expect(validateAgentOutput(contactDraftSchema, contact).company).toBe("Acme");
    expect(validateAgentOutput(trainingAssessmentSchema, training).score).toBeGreaterThan(0);
  });

  it("canonicalizes tracked URLs and filters Toronto-region listings", () => {
    const region = loadRegionConfig(rootDir).regions.find((entry) => entry.id === "toronto-canada");
    const listings = [
      {
        portal: "linkedin",
        sourceUrl: "https://www.linkedin.com/jobs/search",
        applyUrl: "https://www.linkedin.com/jobs/view/123?trk=foo&utm_source=bar",
        company: "Northwind",
        title: "Data Analyst",
        location: "Toronto, Ontario, Canada"
      },
      {
        portal: "generic",
        sourceUrl: "https://company.example/careers",
        applyUrl: "https://company.example/jobs/2",
        company: "Contoso",
        title: "Data Scientist",
        location: "Vancouver, British Columbia, Canada"
      }
    ];

    expect(canonicalizeUrl("https://www.linkedin.com/jobs/view/123?trk=foo&utm_source=bar")).toBe("https://www.linkedin.com/jobs/view/123");
    expect(region).toBeDefined();
    expect(filterListingsByRegion(listings, region!).map((listing) => listing.company)).toEqual(["Northwind"]);
  });
});

describe("pipeline", () => {
  let tempDir: string;
  let pipeline: CareerOpsPipeline;
  let previousDeepSeekKey: string | undefined;
  let previousOpenAiKey: string | undefined;
  let previousOpenRouterKey: string | undefined;
  let previousLlmProvider: string | undefined;

  beforeEach(() => {
    previousDeepSeekKey = process.env.DEEPSEEK_API_KEY;
    previousOpenAiKey = process.env.OPENAI_API_KEY;
    previousOpenRouterKey = process.env.OPENROUTER_API_KEY;
    previousLlmProvider = process.env.LLM_PROVIDER;
    process.env.DEEPSEEK_API_KEY = "";
    process.env.OPENAI_API_KEY = "";
    process.env.OPENROUTER_API_KEY = "";
    process.env.LLM_PROVIDER = "";
    tempDir = mkdtempSync(path.join(tmpdir(), "career-ops-"));
    pipeline = new CareerOpsPipeline(rootDir, path.resolve(tempDir, "career-ops.db"));
  });

  afterEach(() => {
    pipeline.dispose();
    rmSync(tempDir, { recursive: true, force: true });
    if (previousDeepSeekKey == null) {
      delete process.env.DEEPSEEK_API_KEY;
    } else {
      process.env.DEEPSEEK_API_KEY = previousDeepSeekKey;
    }
    if (previousOpenAiKey == null) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = previousOpenAiKey;
    }
    if (previousOpenRouterKey == null) {
      delete process.env.OPENROUTER_API_KEY;
    } else {
      process.env.OPENROUTER_API_KEY = previousOpenRouterKey;
    }
    if (previousLlmProvider == null) {
      delete process.env.LLM_PROVIDER;
    } else {
      process.env.LLM_PROVIDER = previousLlmProvider;
    }
  });

  it("runs a local acceptance flow with richer artifacts", async () => {
    const previousSkipPdf = process.env.CAREER_OPS_SKIP_PDF_RENDER;
    process.env.CAREER_OPS_SKIP_PDF_RENDER = "1";
    pipeline.seedDemoJobs([
      {
        portal: "greenhouse",
        sourceUrl: "https://boards.greenhouse.io/example",
        applyUrl: "https://boards.greenhouse.io/example/jobs/123",
        company: "Acme Analytics",
        title: "Senior Data Analyst",
        location: "Toronto, Ontario, Canada",
        postedAt: new Date().toISOString(),
        compensationText: "$185,000 - $210,000",
        salaryMin: 185000,
        salaryMax: 210000,
        description: "Own SQL reporting, experimentation, dashboarding, stakeholder insights, and product analytics."
      }
    ]);
    try {
      await pipeline.evaluatePending(10);
      const record = pipeline.repo.listJobs()[0];
      expect(record.evaluation?.recommendedAction).toBe("apply");
      const artifactPath = await pipeline.generateResume(record.job.id);
      expect(artifactPath).toMatch(/\.(pdf|html)$/);
      await pipeline.draftApplication(record.job.id);
      const research = await pipeline.researchCompany(record.job.id);
      const contact = await pipeline.draftContact(record.job.id);
      const training = await pipeline.assessTraining("Advanced analytics experimentation course");
      const refreshed = pipeline.repo.getJobRecord(record.job.id);
      expect(refreshed.application?.reviewRequired).toBe(true);
      expect(refreshed.job.status).toBe("ready_to_apply");
      expect(research.company).toBe("Acme Analytics");
      expect(contact.company).toBe("Acme Analytics");
      expect(training.score).toBeGreaterThan(0);
    } finally {
      if (previousSkipPdf == null) {
        delete process.env.CAREER_OPS_SKIP_PDF_RENDER;
      } else {
        process.env.CAREER_OPS_SKIP_PDF_RENDER = previousSkipPdf;
      }
    }
  }, 15000);

  it("caches job listings between reads and invalidates after writes", () => {
    pipeline.seedDemoJobs([
      {
        portal: "greenhouse",
        sourceUrl: "https://boards.greenhouse.io/example",
        applyUrl: "https://boards.greenhouse.io/example/jobs/999",
        company: "Cache Check Inc",
        title: "Data Analyst",
        location: "Toronto, Ontario, Canada",
        postedAt: new Date().toISOString(),
        description: "Cache behavior test listing."
      }
    ]);

    const firstRead = pipeline.repo.listJobs();
    const secondRead = pipeline.repo.listJobs();
    expect(secondRead).toBe(firstRead);

    pipeline.repo.updateJobStatus(firstRead[0]!.job.id, "evaluated");

    const thirdRead = pipeline.repo.listJobs();
    expect(thirdRead).not.toBe(firstRead);
    expect(thirdRead[0]!.job.status).toBe("evaluated");
  });

  it("drops polluted location text from stored compensation fields", () => {
    pipeline.seedDemoJobs([
      {
        portal: "generic",
        sourceUrl: "https://example.com/careers",
        applyUrl: "https://example.com/jobs/123",
        company: "Contoso",
        title: "Business Data Analyst",
        location: "Mississauga, Ontario, Canada",
        compensationText: "Mississauga, Ontario, Canada",
        description: "SQL analytics dashboards and stakeholder reporting."
      }
    ]);

    const record = pipeline.repo.listJobs()[0];
    const normalized = JSON.parse(record.job.normalizedJson) as { compensationText?: string };

    expect(record.job.compensationText).toBeUndefined();
    expect(normalized.compensationText).toBeUndefined();
  });

  it("seeds Toronto discovery sources with senior analyst and analytics engineer searches", () => {
    const ids = pipeline.seedTorontoDiscoverySources();
    const sources = pipeline.listSources({ activeOnly: true, regionId: "toronto-canada" });
    const sourceNames = sources.map((source) => source.name);

    expect(ids).toHaveLength(11);
    expect(sourceNames).toEqual(expect.arrayContaining([
      "LinkedIn Toronto Data Analyst",
      "LinkedIn Toronto Senior Data Analyst",
      "LinkedIn Toronto Analytics Engineer",
      "LinkedIn Toronto Data Scientist",
      "Levels Toronto Data Analyst",
      "Levels Toronto Senior Data Analyst",
      "Levels Toronto Analytics Engineer",
      "Levels Toronto Data Scientist",
      "Workopolis Toronto Data Jobs",
      "Indeed Canada Toronto Data Jobs",
      "SimplyHired Canada Toronto Data Jobs"
    ]));
  });

  it("deactivates legacy Toronto default sources on reseed", () => {
    pipeline.registerSource({
      name: "Stripe Greenhouse",
      sourceUrl: "https://boards.greenhouse.io/embed/job_board?for=stripe",
      kind: "greenhouse",
      regionId: "toronto-canada",
      active: true,
      usePersistentBrowser: false,
      metadata: { role: "data", discoveryOnly: false }
    });
    pipeline.registerSource({
      name: "Levels Toronto Data Jobs (Legacy URL)",
      sourceUrl: "https://www.levels.fyi/jobs/?location=Toronto%2C%20Ontario%2C%20Canada&searchText=data",
      kind: "levels",
      regionId: "toronto-canada",
      active: true,
      usePersistentBrowser: false,
      metadata: { role: "data", discoveryOnly: true }
    });
    pipeline.registerSource({
      name: "Levels Toronto Data Jobs (Legacy Location URL)",
      sourceUrl: "https://www.levels.fyi/jobs/location/greater-toronto-area",
      kind: "levels",
      regionId: "toronto-canada",
      active: true,
      usePersistentBrowser: false,
      metadata: { role: "data", discoveryOnly: true }
    });

    pipeline.seedTorontoDiscoverySources();

    const allSources = pipeline.listSources({ activeOnly: false, regionId: "toronto-canada" });
    const stripeSource = allSources.find((source) => source.sourceUrl === "https://boards.greenhouse.io/embed/job_board?for=stripe");
    const legacyLevelsSource = allSources.find((source) => source.sourceUrl === "https://www.levels.fyi/jobs/?location=Toronto%2C%20Ontario%2C%20Canada&searchText=data");
    const legacyLevelsLocationSource = allSources.find((source) => source.sourceUrl === "https://www.levels.fyi/jobs/location/greater-toronto-area");
    expect(stripeSource?.active).toBe(false);
    expect(legacyLevelsSource?.active).toBe(false);
    expect(legacyLevelsLocationSource?.active).toBe(false);
  });

  it("registers and syncs Toronto discovery sources with canonical apply URLs", async () => {
    const linkedinSourceId = pipeline.registerSource({
      name: "LinkedIn Toronto Data Analyst",
      sourceUrl: "https://www.linkedin.com/jobs/search/?keywords=Data%20Analyst&location=Toronto%2C%20Ontario%2C%20Canada",
      kind: "linkedin",
      regionId: "toronto-canada",
      active: true,
      usePersistentBrowser: true,
      metadata: { discoveryOnly: true }
    });
    const levelsSourceId = pipeline.registerSource({
      name: "Levels Toronto Data Jobs",
      sourceUrl: "https://www.levels.fyi/jobs/?location=Toronto%2C%20Ontario%2C%20Canada&searchText=data",
      kind: "levels",
      regionId: "toronto-canada",
      active: true,
      usePersistentBrowser: false,
      metadata: { discoveryOnly: true }
    });

    const linkedinHtml = `
      <div class="base-search-card">
        <a class="base-card__full-link" href="/jobs/view/123?trk=public_jobs_jobs-search-bar_search-submit&refId=abc">View</a>
        <h3 class="base-search-card__title">Senior Data Analyst</h3>
        <h4 class="base-search-card__subtitle">Northwind Analytics</h4>
        <span class="job-search-card__location">Toronto, Ontario, Canada</span>
      </div>
    `;
    const levelsHtml = `
      <article>
        <a href="https://boards.greenhouse.io/acme/jobs/456?gh_jid=456&utm_source=levels">Apply</a>
        <h3>Data Scientist</h3>
        <div class="company">Acme AI</div>
        <div class="location">Toronto, ON</div>
        <p>$180,000 - $210,000</p>
      </article>
    `;

    const linkedinRun = await pipeline.syncRegisteredSource(linkedinSourceId, linkedinHtml);
    const levelsRun = await pipeline.syncRegisteredSource(levelsSourceId, levelsHtml);
    const sources = pipeline.listSources({ activeOnly: true, regionId: "toronto-canada" });
    const jobs = pipeline.repo.listJobs();
    const applyUrls = jobs.map((record) => record.job.applyUrl);

    expect(linkedinRun.status).toBe("success");
    expect(levelsRun.status).toBe("success");
    expect(sources).toHaveLength(2);
    expect(applyUrls).toContain("https://www.linkedin.com/jobs/view/123");
    expect(applyUrls).toContain("https://boards.greenhouse.io/acme/jobs/456");
  });
});
