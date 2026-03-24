import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApplicationDraft, ensureReviewRequired } from "../src/application";
import { ashbyAdapter, genericCareersAdapter, greenhouseAdapter, leverAdapter, levelsAdapter, linkedinAdapter, workdayAdapter } from "../src/adapters";
import { parseCompensation } from "../src/compensation";
import { loadArchetypeConfig, loadProfilePack, loadRegionConfig, loadScoringConfig } from "../src/config";
import { buildFingerprint, incrementVisitCount, normalizeListing } from "../src/dedup";
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
    expect(canTransition("discovered", "submitted")).toBe(true);
    expect(() => assertTransition("discovered", "submitted")).not.toThrow();
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

  it("parses compensation values without mixing in unrelated numeric text", () => {
    const hourly = parseCompensation("Pay Rate: Starting from $58 per hour. Contract Period: 4 months.");
    expect(hourly.salaryMin).toBe(58);
    expect(hourly.salaryMax).toBeUndefined();

    const currencySuffix = parseCompensation("Compensation: 120,000 CAD - 140,000 CAD base salary.");
    expect(currencySuffix.salaryMin).toBe(120000);
    expect(currencySuffix.salaryMax).toBe(140000);

    const noCommaRange = parseCompensation("Salary: $120000-$150000 CAD based on experience.");
    expect(noCommaRange.salaryMin).toBe(120000);
    expect(noCommaRange.salaryMax).toBe(150000);

    const currentRange = parseCompensation("The current range is $125,000.00 - 130000.00 for this role.");
    expect(currentRange.salaryMin).toBe(125000);
    expect(currentRange.salaryMax).toBe(130000);

    const rangeVariants = [
      {
        text: "Salary range: CAD 115000 - 140000 base salary.",
        min: 115000,
        max: 140000
      },
      {
        text: "Compensation: USD 115,000 to USD 140,000 plus bonus.",
        min: 115000,
        max: 140000
      },
      {
        text: "Annual salary range is 115000-140000 per year depending on level.",
        min: 115000,
        max: 140000
      },
      {
        text: "Expected base pay is $115k - $140k for this position.",
        min: 115000,
        max: 140000
      },
      {
        text: "Our current range is CAD 120,000 – 145,000 with equity.",
        min: 120000,
        max: 145000
      }
    ];

    for (const variant of rangeVariants) {
      const parsed = parseCompensation(variant.text);
      expect(parsed.salaryMin, `failed salaryMin parse for: ${variant.text}`).toBe(variant.min);
      expect(parsed.salaryMax, `failed salaryMax parse for: ${variant.text}`).toBe(variant.max);
    }
  });

  it("validates evaluator schema", () => {
    const report = deterministicEvaluation(job, archetypes, scoring, profile);
    expect(validateAgentOutput(evaluationReportSchema, report).summary).toContain("scores");
  });

  it("parses supported portal fixtures", () => {
    const greenhouseListings = greenhouseAdapter.discoverListings(readFixture("greenhouse.html"), "https://boards.greenhouse.io/example");
    const leverListings = leverAdapter.discoverListings(readFixture("lever.html"), "https://jobs.lever.co/example");
    const workdayListings = workdayAdapter.discoverListings(readFixture("workday.html"), "https://company.workdayjobs.com/example");
    const greenhouseApiListings = greenhouseAdapter.discoverListings(JSON.stringify({
      jobs: [
        {
          id: 1001,
          title: "Senior Data Analyst",
          absolute_url: "https://boards.greenhouse.io/example/jobs/1001",
          updated_at: "2026-03-20T03:00:00.000Z",
          location: { name: "Toronto, Ontario, Canada" },
          content: "<p>$120,000 - $145,000 CAD</p>"
        }
      ]
    }), "https://boards.greenhouse.io/embed/job_board?for=example");
    const leverApiListings = leverAdapter.discoverListings(JSON.stringify([
      {
        id: "lev-1002",
        text: "Analytics Engineer",
        hostedUrl: "https://jobs.lever.co/example/lev-1002",
        createdAt: 1773982800000,
        descriptionPlain: "Build dashboards and experimentation workflows. Compensation $130,000 - $160,000.",
        categories: {
          location: "Toronto, Ontario, Canada",
          commitment: "Full-time"
        }
      }
    ]), "https://jobs.lever.co/example");

    expect(greenhouseListings.length).toBe(1);
    expect(greenhouseListings[0]?.compensationText).toBeUndefined();
    expect(leverListings[0]?.title).toContain("Solutions");
    expect(leverListings[0]?.compensationText).toBeUndefined();
    expect(ashbyAdapter.discoverListings(readFixture("ashby.html"), "https://jobs.ashbyhq.com/example")[0]?.company).toContain("jobs.ashbyhq.com");
    expect(workdayListings.length).toBe(1);
    expect(workdayListings[0]?.compensationText).toBeUndefined();
    expect(genericCareersAdapter.discoverListings(readFixture("generic.html"), "https://company.com/careers")[0]?.salaryMin).toBe(200000);
    expect(greenhouseApiListings[0]?.postedAt).toBe("2026-03-20T03:00:00.000Z");
    expect(greenhouseApiListings[0]?.salaryMin).toBe(120000);
    expect(leverApiListings[0]?.postedAt).toBe("2026-03-20T05:00:00.000Z");
    expect(leverApiListings[0]?.employmentType).toBe("Full-time");
  });

  it("parses linkedin and levels discovery pages and preserves canonical URLs", () => {
    const linkedinHtml = `
      <div class="base-search-card">
        <a class="base-card__full-link" href="https://jobs.northwind.com/apply/123?utm_source=linkedin&ref=abc" data-linkedin-compensation="Salary range: $125,000.00 - $130,000.00 CAD base + bonus">View</a>
        <h3 class="base-search-card__title">Senior Data Analyst</h3>
        <h4 class="base-search-card__subtitle">Northwind Analytics</h4>
        <span class="job-search-card__location">Toronto, Ontario, Canada</span>
        <time datetime="2026-03-20T11:00:00.000Z">1 hour ago</time>
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

    expect(linkedinListing.applyUrl).toBe("https://jobs.northwind.com/apply/123");
    expect(linkedinListing.postedAt).toBe("2026-03-20T11:00:00.000Z");
    expect(linkedinListing.salaryMin).toBe(125000);
    expect(linkedinListing.salaryMax).toBe(130000);
    expect(levelsListing.applyUrl).toBe("https://boards.greenhouse.io/acme/jobs/456");
    expect(levelsListing.salaryMin).toBe(180000);
    expect(levelsListing.company).toBe("Acme AI");
  });

  it("prefers linkedin relative age text when datetime is date-only", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-20T12:00:00.000Z"));
    try {
      const linkedinHtml = `
        <div class="base-search-card">
          <a class="base-card__full-link" href="https://jobs.northwind.com/apply/123?utm_source=linkedin&ref=abc">View</a>
          <h3 class="base-search-card__title">Senior Data Analyst</h3>
          <h4 class="base-search-card__subtitle">Northwind Analytics</h4>
          <span class="job-search-card__location">Toronto, Ontario, Canada</span>
          <time datetime="2026-03-19">16 hours ago</time>
        </div>
      `;
      const listing = linkedinAdapter.discoverListings(linkedinHtml, "https://www.linkedin.com/jobs/search/?keywords=Data%20Analyst")[0];
      expect(listing?.postedAt).toBe("2026-03-19T20:00:00.000Z");
    } finally {
      vi.useRealTimers();
    }
  });

  it("parses workopolis cards with actual company names", () => {
    const workopolisHtml = `
      <ul>
        <li>
          <div data-testid="searchSerpJob">
            <a class="chakra-button" href="/jobsearch/viewjob/abc123">Open</a>
            <h2 data-testid="searchSerpJobTitle">Senior Data Analyst</h2>
            <span data-testid="companyName">Acme Analytics</span>
            <span data-testid="searchSerpJobLocation">Toronto, ON</span>
            <span data-testid="salaryChip-0">$120,000 a year</span>
          </div>
        </li>
      </ul>
    `;
    const listing = genericCareersAdapter.discoverListings(workopolisHtml, "https://www.workopolis.com/jobsearch/find-jobs?q=data")[0];
    expect(listing).toBeDefined();
    expect(listing?.company).toBe("Acme Analytics");
    expect(listing?.applyUrl).toBe("https://www.workopolis.com/jobsearch/viewjob/abc123");
    expect(listing?.location).toBe("Toronto, ON");
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

  it("keeps linkedin-hosted apply URLs when external apply links are unavailable", () => {
    const linkedinHtml = `
      <div class="base-search-card">
        <a class="base-card__full-link" href="https://www.linkedin.com/jobs/view/98765?trk=guest_search">View</a>
        <h3 class="base-search-card__title">Data Analyst</h3>
        <h4 class="base-search-card__subtitle">Northwind Analytics</h4>
        <span class="job-search-card__location">Toronto, Ontario, Canada</span>
      </div>
    `;
    const listing = linkedinAdapter.discoverListings(linkedinHtml, "https://www.linkedin.com/jobs/search/?keywords=Data%20Analyst")[0];
    expect(listing).toBeDefined();
    expect(listing?.applyUrl).toBe("https://www.linkedin.com/jobs/view/98765");
    expect(listing?.metadata?.linkedinHostedApply).toBe(true);
  });

  it("keeps both external and linkedin-hosted apply URLs from LinkedIn discovery pages", () => {
    const linkedinHtml = `
      <div class="base-search-card">
        <a class="base-card__full-link" href="https://careers.northwind.com/jobs/123?utm_source=linkedin">View</a>
        <h3 class="base-search-card__title">Senior Data Analyst</h3>
        <h4 class="base-search-card__subtitle">Northwind Analytics</h4>
        <span class="job-search-card__location">Toronto, Ontario, Canada</span>
      </div>
      <div class="base-search-card">
        <a class="base-card__full-link" href="https://www.linkedin.com/jobs/view/98765?trk=guest_search">View</a>
        <h3 class="base-search-card__title">Data Analyst</h3>
        <h4 class="base-search-card__subtitle">Northwind Analytics</h4>
        <span class="job-search-card__location">Toronto, Ontario, Canada</span>
      </div>
    `;
    const listings = linkedinAdapter.discoverListings(linkedinHtml, "https://www.linkedin.com/jobs/search/?keywords=Data%20Analyst");
    expect(listings).toHaveLength(2);
    expect(listings[0]?.applyUrl).toBe("https://careers.northwind.com/jobs/123");
    expect(listings[0]?.metadata?.linkedinHostedApply).toBeUndefined();
    expect(listings[1]?.applyUrl).toBe("https://www.linkedin.com/jobs/view/98765");
    expect(listings[1]?.metadata?.linkedinHostedApply).toBe(true);
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
    expect(
      canonicalizeUrl("https://ca.linkedin.com/jobs/view/data-scientist-at-interac-corp-4359267316?position=10&pageNum=0")
    ).toBe("https://ca.linkedin.com/jobs/view/data-scientist-at-interac-corp-4359267316");
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

  it("caches job listings between reads and updates cache after status writes", () => {
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
    expect(thirdRead).toBe(firstRead);
    expect(thirdRead[0]!.job.status).toBe("evaluated");
  });

  it("deduplicates canonical apply-url variants and preserves compensation details", () => {
    const firstId = pipeline.repo.upsertJob(normalizeListing({
      portal: "generic",
      sourceUrl: "https://example.com/careers",
      applyUrl: "https://example.com/jobs/123",
      company: "Acme Analytics",
      title: "Data Analyst",
      location: "Toronto, Ontario, Canada",
      compensationText: "$120,000 - $150,000",
      salaryMin: 120000,
      salaryMax: 150000,
      description: "Initial variant with compensation."
    }, "normalized"));

    const secondId = pipeline.repo.upsertJob(normalizeListing({
      portal: "generic",
      sourceUrl: "https://example.com/careers",
      applyUrl: "https://example.com/jobs/123",
      company: "Acme Analytics",
      title: "Data Analyst",
      location: "Remote",
      externalId: "acme-123",
      description: "Duplicate variant without compensation."
    }, "normalized"));

    const records = pipeline.repo.listJobs();
    expect(secondId).toBe(firstId);
    expect(records).toHaveLength(1);
    expect(records[0]?.job.salaryMin).toBe(120000);
    expect(records[0]?.job.salaryMax).toBe(150000);
    expect(records[0]?.job.compensationText).toBe("$120,000 - $150,000");
  });

  it("keeps only the latest posted_at for duplicate postings of the same role", () => {
    const olderPostedAt = "2026-03-20T09:00:00.000Z";
    const newerPostedAt = "2026-03-22T09:00:00.000Z";
    const applyUrl = "https://example.com/jobs/999";

    pipeline.repo.upsertJob(normalizeListing({
      portal: "generic",
      sourceUrl: "https://example.com/careers",
      applyUrl,
      company: "Acme Analytics",
      title: "Senior Data Analyst",
      location: "Toronto, Ontario, Canada",
      postedAt: olderPostedAt,
      description: "Older posting snapshot."
    }, "normalized"));

    const newerId = pipeline.repo.upsertJob(normalizeListing({
      portal: "generic",
      sourceUrl: "https://example.com/careers",
      applyUrl,
      company: "Acme Analytics",
      title: "Senior Data Analyst",
      location: "Toronto, Ontario, Canada",
      postedAt: newerPostedAt,
      description: "Newer posting snapshot."
    }, "normalized"));

    // Re-ingest an older variant to ensure the latest posted_at is not downgraded.
    const olderReingestId = pipeline.repo.upsertJob(normalizeListing({
      portal: "generic",
      sourceUrl: "https://example.com/careers",
      applyUrl,
      company: "Acme Analytics",
      title: "Senior Data Analyst",
      location: "Remote",
      externalId: "legacy-variant",
      postedAt: olderPostedAt,
      description: "Reingested older variant."
    }, "normalized"));

    const records = pipeline.repo.listJobs();
    expect(records).toHaveLength(1);
    expect(olderReingestId).toBe(newerId);
    expect(records[0]?.job.postedAt).toBe(newerPostedAt);
  });

  it("deduplicates same-link variants and stores the canonical apply url", () => {
    const olderPostedAt = "2026-03-20T09:00:00.000Z";
    const newerPostedAt = "2026-03-22T09:00:00.000Z";
    const trackedApplyUrl = "https://example.com/jobs/200?utm_source=linkedin&ref=campaign";
    const canonicalApplyUrl = "https://example.com/jobs/200";

    const firstId = pipeline.repo.upsertJob(normalizeListing({
      portal: "generic",
      sourceUrl: "https://example.com/careers",
      applyUrl: trackedApplyUrl,
      company: "Acme Analytics",
      title: "Data Analyst",
      location: "Toronto, Ontario, Canada",
      postedAt: olderPostedAt,
      description: "Tracked link variant."
    }, "normalized"));

    const secondId = pipeline.repo.upsertJob(normalizeListing({
      portal: "generic",
      sourceUrl: "https://example.com/careers",
      applyUrl: canonicalApplyUrl,
      company: "Acme Analytics Inc.",
      title: "Business Data Analyst",
      location: "Remote",
      postedAt: newerPostedAt,
      description: "Canonical link variant."
    }, "normalized"));

    const records = pipeline.repo.listJobs();
    expect(records).toHaveLength(1);
    expect(secondId).toBe(firstId);
    expect(records[0]?.job.applyUrl).toBe("https://example.com/jobs/200");
    expect(records[0]?.job.postedAt).toBe(newerPostedAt);
  });

  it("deduplicates linkedin hosted variants with different list params and job ids for the same slug", () => {
    const olderPostedAt = "2026-03-20T09:00:00.000Z";
    const newerPostedAt = "2026-03-22T09:00:00.000Z";

    const firstId = pipeline.repo.upsertJob(normalizeListing({
      portal: "linkedin",
      sourceUrl: "https://www.linkedin.com/jobs/search/?keywords=Data%20Scientist&location=Toronto%2C%20Ontario%2C%20Canada&f_TPR=r86400",
      applyUrl: "https://ca.linkedin.com/jobs/view/credit-analyst-business-banking-at-bmo-4385518987?position=2&pageNum=2",
      company: "BMO",
      title: "Credit Analyst - Business Banking",
      location: "Mississauga, Ontario, Canada",
      postedAt: olderPostedAt,
      description: "Mississauga, Ontario, Canada Actively Hiring 4 hours ago"
    }, "normalized"));

    const secondId = pipeline.repo.upsertJob(normalizeListing({
      portal: "linkedin",
      sourceUrl: "https://www.linkedin.com/jobs/search/?keywords=Senior%20Data%20Analyst&location=Toronto%2C%20Ontario%2C%20Canada&f_TPR=r86400",
      applyUrl: "https://ca.linkedin.com/jobs/view/credit-analyst-business-banking-at-bmo-4385521737?position=3&pageNum=2",
      company: "BMO",
      title: "Credit Analyst - Business Banking",
      location: "Mississauga, Ontario, Canada",
      postedAt: newerPostedAt,
      description: "Mississauga, Ontario, Canada Actively Hiring 4 hours ago"
    }, "normalized"));

    const records = pipeline.repo.listJobs();
    expect(records).toHaveLength(1);
    expect(secondId).toBe(firstId);
    expect(records[0]?.job.postedAt).toBe(newerPostedAt);
    expect(records[0]?.job.applyUrl).toBe("https://ca.linkedin.com/jobs/view/credit-analyst-business-banking-at-bmo-4385521737");
  });

  it("excludes configured companies during crawl ingestion", async () => {
    pipeline.excludeCompany("Acme Analytics");
    const html = `
      <ul>
        <li>
          <div data-testid="searchSerpJob">
            <a href="/jobsearch/viewjob/acme-1">Open</a>
            <h2 data-testid="searchSerpJobTitle">Data Analyst</h2>
            <span data-testid="companyName">Acme Analytics</span>
            <span data-testid="searchSerpJobLocation">Toronto, ON</span>
          </div>
        </li>
        <li>
          <div data-testid="searchSerpJob">
            <a href="/jobsearch/viewjob/contoso-1">Open</a>
            <h2 data-testid="searchSerpJobTitle">Data Scientist</h2>
            <span data-testid="companyName">Contoso Labs</span>
            <span data-testid="searchSerpJobLocation">Toronto, ON</span>
          </div>
        </li>
      </ul>
    `;

    const summary = await pipeline.scanSource(
      "https://www.workopolis.com/jobsearch/find-jobs?q=data",
      html,
      { persistRun: false }
    );
    const records = pipeline.repo.listJobs();

    expect(summary.processed).toBe(1);
    expect(records).toHaveLength(1);
    expect(records[0]?.job.company).toBe("Contoso Labs");
  });

  it("reuses application-answer memory in drafts and tracks usage", async () => {
    const [jobId] = pipeline.seedDemoJobs([
      {
        portal: "greenhouse",
        sourceUrl: "https://boards.greenhouse.io/example",
        applyUrl: "https://boards.greenhouse.io/example/jobs/2000",
        company: "Memory Check Inc",
        title: "Data Analyst",
        location: "Toronto, Ontario, Canada",
        postedAt: new Date().toISOString(),
        description: "Draft memory test listing."
      }
    ]);

    pipeline.rememberApplicationAnswer("why are you interested in this role", "I enjoy shipping analytics that drive product decisions.");
    pipeline.rememberApplicationAnswer("full_name", "Memory Override Name");

    await pipeline.draftApplication(jobId);

    const draft = pipeline.repo.getJobRecord(jobId).application;
    expect(draft).not.toBeNull();
    expect(draft?.answers["why are you interested in this role"]).toBe("I enjoy shipping analytics that drive product decisions.");
    expect(draft?.answers.full_name).toBe("Memory Override Name");
    expect(draft?.roleSpecificAnswers.some((answer) => answer.includes("why are you interested in this role"))).toBe(true);

    const memoryEntries = pipeline.listApplicationAnswerMemory();
    const whyEntry = memoryEntries.find((entry) => entry.questionKey === "why are you interested in this role");
    expect(whyEntry).toBeDefined();
    expect(whyEntry?.usageCount).toBeGreaterThanOrEqual(1);
    expect(whyEntry?.lastUsedAt).toBeDefined();
  });

  it("records resume variant performance feedback and exposes summaries", async () => {
    const previousSkipPdf = process.env.CAREER_OPS_SKIP_PDF_RENDER;
    process.env.CAREER_OPS_SKIP_PDF_RENDER = "1";
    try {
      const [jobId] = pipeline.seedDemoJobs([
        {
          portal: "greenhouse",
          sourceUrl: "https://boards.greenhouse.io/example",
          applyUrl: "https://boards.greenhouse.io/example/jobs/3000",
          company: "Feedback Signals Inc",
          title: "Data Scientist",
          location: "Toronto, Ontario, Canada",
          postedAt: new Date().toISOString(),
          description: "Resume feedback test listing."
        }
      ]);

      await pipeline.generateResume(jobId);
      await pipeline.recordResumeVariantFeedback(jobId, {
        outcome: "interview",
        score: 4.4,
        notes: "Strong alignment with the hiring manager's expectations."
      });

      const feedback = pipeline.listResumeVariantFeedback(10);
      const saved = feedback.find((entry) => entry.jobId === jobId);
      expect(saved).toBeDefined();
      expect(saved?.outcome).toBe("interview");
      expect(saved?.score).toBe(4.4);

      const summary = pipeline.summarizeResumeVariantFeedback();
      expect(summary.totalFeedback).toBeGreaterThanOrEqual(1);
      expect(summary.byOutcome.interview).toBeGreaterThanOrEqual(1);
      expect(summary.topKeywordSignals.length).toBeGreaterThan(0);
    } finally {
      if (previousSkipPdf == null) {
        delete process.env.CAREER_OPS_SKIP_PDF_RENDER;
      } else {
        process.env.CAREER_OPS_SKIP_PDF_RENDER = previousSkipPdf;
      }
    }
  });

  it("clears all listings and listing artifacts", async () => {
    const [jobId] = pipeline.seedDemoJobs([
      {
        portal: "greenhouse",
        sourceUrl: "https://boards.greenhouse.io/example",
        applyUrl: "https://boards.greenhouse.io/example/jobs/1000",
        company: "Cleanup Inc",
        title: "Data Analyst",
        location: "Toronto, Ontario, Canada",
        postedAt: new Date().toISOString(),
        description: "Listing cleanup test job."
      }
    ]);
    await pipeline.evaluateJob(jobId);

    const before = pipeline.repo.listJobs();
    expect(before).toHaveLength(1);
    expect(before[0]?.evaluation).not.toBeNull();

    const deleted = pipeline.repo.clearListings();

    expect(deleted.jobs).toBeGreaterThanOrEqual(1);
    expect(deleted.evaluations).toBeGreaterThanOrEqual(1);
    expect(pipeline.repo.listJobs()).toHaveLength(0);
  });

  it("refreshes cached listings after out-of-band database updates", () => {
    pipeline.seedDemoJobs([
      {
        portal: "greenhouse",
        sourceUrl: "https://boards.greenhouse.io/example",
        applyUrl: "https://boards.greenhouse.io/example/jobs/1000",
        company: "External Write Inc",
        title: "Data Analyst",
        location: "Toronto, Ontario, Canada",
        postedAt: new Date().toISOString(),
        description: "Cache refresh behavior test listing."
      }
    ]);

    const cachedRead = pipeline.repo.listJobs();
    const jobId = cachedRead[0]!.job.id;
    pipeline.repo.sqlite.prepare("update jobs set title = ?, updated_at = ? where id = ?")
      .run("Data Analyst Updated Externally", new Date().toISOString(), jobId);

    const staleRead = pipeline.repo.listJobs();
    expect(staleRead).toBe(cachedRead);
    expect(staleRead[0]!.job.title).toBe("Data Analyst");

    const refreshedRead = pipeline.repo.refreshJobs();
    expect(refreshedRead).not.toBe(cachedRead);
    expect(refreshedRead[0]!.job.title).toBe("Data Analyst Updated Externally");
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
    const linkedinSources = sources.filter((source) => source.kind === "linkedin");

    expect(ids).toHaveLength(20);
    expect(sourceNames).toEqual(expect.arrayContaining([
      "LinkedIn Toronto Data Analyst",
      "LinkedIn Toronto Senior Data Analyst",
      "LinkedIn Toronto Analytics Engineer",
      "LinkedIn Toronto Data Scientist",
      "Levels Toronto Data Analyst",
      "Levels Toronto Senior Data Analyst",
      "Levels Toronto Analytics Engineer",
      "Levels Toronto Data Scientist",
      "Workopolis Toronto Data Analyst Jobs",
      "Workopolis Toronto Senior Data Analyst Jobs",
      "Workopolis Toronto Analytics Engineer Jobs",
      "Workopolis Toronto Data Scientist Jobs",
      "Indeed Canada Toronto Data Analyst Jobs",
      "Indeed Canada Toronto Senior Data Analyst Jobs",
      "Indeed Canada Toronto Analytics Engineer Jobs",
      "Indeed Canada Toronto Data Scientist Jobs",
      "SimplyHired Canada Toronto Data Analyst Jobs",
      "SimplyHired Canada Toronto Senior Data Analyst Jobs",
      "SimplyHired Canada Toronto Analytics Engineer Jobs",
      "SimplyHired Canada Toronto Data Scientist Jobs"
    ]));
    for (const source of linkedinSources) {
      expect(new URL(source.sourceUrl).searchParams.get("f_TPR")).toBe("r86400");
    }
    const workopolisSources = sources.filter((source) => source.name.startsWith("Workopolis Toronto "));
    const indeedSources = sources.filter((source) => source.name.startsWith("Indeed Canada Toronto "));
    const simplyHiredSources = sources.filter((source) => source.name.startsWith("SimplyHired Canada Toronto "));
    expect(workopolisSources).toHaveLength(4);
    expect(indeedSources).toHaveLength(4);
    expect(simplyHiredSources).toHaveLength(4);
    for (const source of [...workopolisSources, ...indeedSources, ...simplyHiredSources]) {
      expect(source.sourceUrl).not.toContain(" OR ");
      expect(source.metadata?.maxAgeHours).toBe(24);
    }
    for (const source of workopolisSources) {
      expect(new URL(source.sourceUrl).searchParams.get("d")).toBe("1");
    }
    for (const source of indeedSources) {
      expect(new URL(source.sourceUrl).searchParams.get("fromage")).toBe("1");
    }
    for (const source of simplyHiredSources) {
      expect(new URL(source.sourceUrl).searchParams.get("fdb")).toBe("1");
    }
  });

  it("deactivates legacy Toronto default sources on reseed", () => {
    pipeline.registerSource({
      name: "Greenhouse Stripe Data Jobs",
      sourceUrl: "https://boards.greenhouse.io/embed/job_board?for=stripe",
      kind: "greenhouse",
      regionId: "toronto-canada",
      active: true,
      usePersistentBrowser: false,
      metadata: { role: "data", discoveryOnly: true }
    });
    pipeline.registerSource({
      name: "Lever ShyftLabs Toronto Data Jobs",
      sourceUrl: "https://jobs.lever.co/shyftlabs?location=Toronto%2C+Ontario",
      kind: "lever",
      regionId: "toronto-canada",
      active: true,
      usePersistentBrowser: false,
      metadata: { role: "data", discoveryOnly: true }
    });
    pipeline.registerSource({
      name: "Lever Caseware Toronto Data Jobs",
      sourceUrl: "https://jobs.lever.co/caseware",
      kind: "lever",
      regionId: "toronto-canada",
      active: true,
      usePersistentBrowser: false,
      metadata: { role: "data", discoveryOnly: true }
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
    pipeline.registerSource({
      name: "Workopolis Toronto Data Jobs (Legacy OR URL)",
      sourceUrl: "https://www.workopolis.com/jobsearch/find-jobs?ak=Data+Analyst+OR+Senior+Data+Analyst+OR+Analytics+Engineer+OR+Data+Scientist&l=Toronto%2C+ON",
      kind: "generic",
      regionId: "toronto-canada",
      active: true,
      usePersistentBrowser: false,
      metadata: { role: "data", discoveryOnly: true }
    });
    pipeline.registerSource({
      name: "Indeed Canada Toronto Data Jobs (Legacy OR URL)",
      sourceUrl: "https://ca.indeed.com/jobs?q=Data+Analyst+OR+Senior+Data+Analyst+OR+Analytics+Engineer+OR+Data+Scientist&l=Toronto%2C+ON",
      kind: "generic",
      regionId: "toronto-canada",
      active: true,
      usePersistentBrowser: false,
      metadata: { role: "data", discoveryOnly: true }
    });
    pipeline.registerSource({
      name: "SimplyHired Canada Toronto Data Jobs (Legacy OR URL)",
      sourceUrl: "https://www.simplyhired.ca/search?q=Data+Analyst+OR+Senior+Data+Analyst+OR+Analytics+Engineer+OR+Data+Scientist&l=Toronto%2C+ON",
      kind: "generic",
      regionId: "toronto-canada",
      active: true,
      usePersistentBrowser: false,
      metadata: { role: "data", discoveryOnly: true }
    });

    pipeline.seedTorontoDiscoverySources();

    const allSources = pipeline.listSources({ activeOnly: false, regionId: "toronto-canada" });
    const legacyGreenhouseSource = allSources.find((source) => source.sourceUrl === "https://boards.greenhouse.io/embed/job_board?for=stripe");
    const legacyLeverShyftlabsSource = allSources.find((source) => source.sourceUrl === "https://jobs.lever.co/shyftlabs?location=Toronto%2C+Ontario");
    const legacyLeverCasewareSource = allSources.find((source) => source.sourceUrl === "https://jobs.lever.co/caseware");
    const legacyLevelsSource = allSources.find((source) => source.sourceUrl === "https://www.levels.fyi/jobs/?location=Toronto%2C%20Ontario%2C%20Canada&searchText=data");
    const legacyLevelsLocationSource = allSources.find((source) => source.sourceUrl === "https://www.levels.fyi/jobs/location/greater-toronto-area");
    const legacyWorkopolisSource = allSources.find((source) => source.sourceUrl === "https://www.workopolis.com/jobsearch/find-jobs?ak=Data+Analyst+OR+Senior+Data+Analyst+OR+Analytics+Engineer+OR+Data+Scientist&l=Toronto%2C+ON");
    const legacyIndeedSource = allSources.find((source) => source.sourceUrl === "https://ca.indeed.com/jobs?q=Data+Analyst+OR+Senior+Data+Analyst+OR+Analytics+Engineer+OR+Data+Scientist&l=Toronto%2C+ON");
    const legacySimplyHiredSource = allSources.find((source) => source.sourceUrl === "https://www.simplyhired.ca/search?q=Data+Analyst+OR+Senior+Data+Analyst+OR+Analytics+Engineer+OR+Data+Scientist&l=Toronto%2C+ON");
    expect(legacyGreenhouseSource?.active).toBe(false);
    expect(legacyLeverShyftlabsSource?.active).toBe(false);
    expect(legacyLeverCasewareSource?.active).toBe(false);
    expect(legacyLevelsSource?.active).toBe(false);
    expect(legacyLevelsLocationSource?.active).toBe(false);
    expect(legacyWorkopolisSource?.active).toBe(false);
    expect(legacyIndeedSource?.active).toBe(false);
    expect(legacySimplyHiredSource?.active).toBe(false);
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
        <a class="base-card__full-link" href="https://careers.northwind.com/jobs/123?utm_source=linkedin&ref=abc">View</a>
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
    expect(applyUrls).toContain("https://careers.northwind.com/jobs/123");
    expect(applyUrls).toContain("https://boards.greenhouse.io/acme/jobs/456");
  });

  it("applies default role and 24-hour filters for greenhouse discovery sources", async () => {
    const greenhouseSourceId = pipeline.registerSource({
      name: "Greenhouse Data Roles",
      sourceUrl: "https://boards.greenhouse.io/embed/job_board?for=example",
      kind: "greenhouse",
      regionId: "toronto-canada",
      active: true,
      usePersistentBrowser: false,
      metadata: { discoveryOnly: true }
    });
    const recentPostedAt = new Date(Date.now() - (2 * 60 * 60 * 1000)).toISOString();
    const stalePostedAt = new Date(Date.now() - (48 * 60 * 60 * 1000)).toISOString();
    const greenhouseApiPayload = JSON.stringify({
      jobs: [
        {
          id: 1,
          title: "Senior Data Analyst",
          absolute_url: "https://boards.greenhouse.io/example/jobs/1",
          updated_at: recentPostedAt,
          location: { name: "Toronto, Ontario, Canada" },
          content: "<p>SQL experimentation</p>"
        },
        {
          id: 2,
          title: "Frontend Engineer",
          absolute_url: "https://boards.greenhouse.io/example/jobs/2",
          updated_at: recentPostedAt,
          location: { name: "Toronto, Ontario, Canada" },
          content: "<p>React frontend role</p>"
        },
        {
          id: 3,
          title: "Data Scientist",
          absolute_url: "https://boards.greenhouse.io/example/jobs/3",
          updated_at: stalePostedAt,
          location: { name: "Toronto, Ontario, Canada" },
          content: "<p>Modeling role</p>"
        }
      ]
    });

    const run = await pipeline.syncRegisteredSource(greenhouseSourceId, greenhouseApiPayload);
    const jobs = pipeline.repo.listJobs();

    expect(run.status).toBe("success");
    expect(run.processed).toBe(1);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.job.title).toBe("Senior Data Analyst");
  });

  it("excludes manager/director/lead and senior/system analyst variants while keeping data scientist", async () => {
    const sourceId = pipeline.registerSource({
      name: "Greenhouse DS Title Filter",
      sourceUrl: "https://boards.greenhouse.io/embed/job_board?for=example",
      kind: "greenhouse",
      regionId: "toronto-canada",
      active: true,
      usePersistentBrowser: false,
      metadata: { discoveryOnly: true }
    });
    const recentPostedAt = new Date(Date.now() - (60 * 60 * 1000)).toISOString();
    const greenhouseApiPayload = JSON.stringify({
      jobs: [
        {
          id: 2001,
          title: "Data Scientist",
          absolute_url: "https://boards.greenhouse.io/example/jobs/2001",
          updated_at: recentPostedAt,
          location: { name: "Toronto, Ontario, Canada" },
          content: "<p>IC role</p>"
        },
        {
          id: 2002,
          title: "Senior Data Scientist",
          absolute_url: "https://boards.greenhouse.io/example/jobs/2002",
          updated_at: recentPostedAt,
          location: { name: "Toronto, Ontario, Canada" },
          content: "<p>Senior IC role</p>"
        },
        {
          id: 2003,
          title: "Analytics Manager",
          absolute_url: "https://boards.greenhouse.io/example/jobs/2003",
          updated_at: recentPostedAt,
          location: { name: "Toronto, Ontario, Canada" },
          content: "<p>Manager role</p>"
        },
        {
          id: 2004,
          title: "Director, Data Science",
          absolute_url: "https://boards.greenhouse.io/example/jobs/2004",
          updated_at: recentPostedAt,
          location: { name: "Toronto, Ontario, Canada" },
          content: "<p>Director role</p>"
        },
        {
          id: 2005,
          title: "Lead Data Scientist",
          absolute_url: "https://boards.greenhouse.io/example/jobs/2005",
          updated_at: recentPostedAt,
          location: { name: "Toronto, Ontario, Canada" },
          content: "<p>Lead role</p>"
        },
        {
          id: 2006,
          title: "Senior Data Engineer",
          absolute_url: "https://boards.greenhouse.io/example/jobs/2006",
          updated_at: recentPostedAt,
          location: { name: "Toronto, Ontario, Canada" },
          content: "<p>Senior DE role</p>"
        },
        {
          id: 2007,
          title: "Systems Analyst",
          absolute_url: "https://boards.greenhouse.io/example/jobs/2007",
          updated_at: recentPostedAt,
          location: { name: "Toronto, Ontario, Canada" },
          content: "<p>Systems role</p>"
        },
        {
          id: 2008,
          title: "Senior Machine Learning Engineer",
          absolute_url: "https://boards.greenhouse.io/example/jobs/2008",
          updated_at: recentPostedAt,
          location: { name: "Toronto, Ontario, Canada" },
          content: "<p>Senior MLE role</p>"
        }
      ]
    });

    const run = await pipeline.syncRegisteredSource(sourceId, greenhouseApiPayload);
    const jobs = pipeline.repo.listJobs();

    expect(run.status).toBe("success");
    expect(run.processed).toBe(1);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.job.title).toBe("Data Scientist");
  });

  it("applies default 24-hour filter for linkedin discovery sources when postedAt is available", async () => {
    const linkedinSourceId = pipeline.registerSource({
      name: "LinkedIn Toronto Data Analyst",
      sourceUrl: "https://www.linkedin.com/jobs/search/?keywords=Data%20Analyst&location=Toronto%2C%20Ontario%2C%20Canada",
      kind: "linkedin",
      regionId: "toronto-canada",
      active: true,
      usePersistentBrowser: false,
      metadata: { discoveryOnly: true }
    });
    const recentPostedAt = new Date(Date.now() - (2 * 60 * 60 * 1000)).toISOString();
    const stalePostedAt = new Date(Date.now() - (48 * 60 * 60 * 1000)).toISOString();
    const linkedinHtml = `
      <div class="base-search-card">
        <a class="base-card__full-link" href="https://www.linkedin.com/jobs/view/11111?trk=guest_search">View</a>
        <h3 class="base-search-card__title">Senior Data Analyst</h3>
        <h4 class="base-search-card__subtitle">Northwind Analytics</h4>
        <span class="job-search-card__location">Toronto, Ontario, Canada</span>
        <time datetime="${recentPostedAt}">2 hours ago</time>
      </div>
      <div class="base-search-card">
        <a class="base-card__full-link" href="https://www.linkedin.com/jobs/view/22222?trk=guest_search">View</a>
        <h3 class="base-search-card__title">Data Scientist</h3>
        <h4 class="base-search-card__subtitle">Contoso AI</h4>
        <span class="job-search-card__location">Toronto, Ontario, Canada</span>
        <time datetime="${stalePostedAt}">2 days ago</time>
      </div>
    `;

    const run = await pipeline.syncRegisteredSource(linkedinSourceId, linkedinHtml);
    const jobs = pipeline.repo.listJobs();

    expect(run.status).toBe("success");
    expect(run.processed).toBe(1);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.job.title).toBe("Senior Data Analyst");
  });

  it("keeps linkedin-hosted apply URLs for LinkedIn discovery sources", async () => {
    const linkedinSourceId = pipeline.registerSource({
      name: "LinkedIn Toronto Data Analyst",
      sourceUrl: "https://www.linkedin.com/jobs/search/?keywords=Data%20Analyst&location=Toronto%2C%20Ontario%2C%20Canada",
      kind: "linkedin",
      regionId: "toronto-canada",
      active: true,
      usePersistentBrowser: false,
      metadata: { discoveryOnly: true }
    });
    const linkedinHtml = `
      <div class="base-search-card">
        <a class="base-card__full-link" href="https://www.linkedin.com/jobs/view/98765?trk=guest_search">View</a>
        <h3 class="base-search-card__title">Data Analyst</h3>
        <h4 class="base-search-card__subtitle">Northwind Analytics</h4>
        <span class="job-search-card__location">Toronto, Ontario, Canada</span>
      </div>
    `;

    const run = await pipeline.syncRegisteredSource(linkedinSourceId, linkedinHtml);

    expect(run.status).toBe("success");
    expect(run.processed).toBe(1);
    expect(run.created).toBe(1);
    const jobs = pipeline.repo.listJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.job.applyUrl).toBe("https://www.linkedin.com/jobs/view/98765");
  });

  it("falls back to source URL location when extracted listings have unknown location", async () => {
    const sourceId = pipeline.registerSource({
      name: "Fallback location source",
      sourceUrl: "https://example.com/jobs?q=data+analyst&l=Toronto%2C+ON",
      kind: "generic",
      regionId: "toronto-canada",
      active: true,
      usePersistentBrowser: false,
      metadata: { discoveryOnly: true, titleKeywords: ["data analyst"] }
    });
    const html = `
      <article>
        <a href="https://example.com/jobs/123">Apply</a>
        <h3>Data Analyst</h3>
        <p>SQL and dashboard reporting</p>
      </article>
    `;
    const run = await pipeline.syncRegisteredSource(sourceId, html);
    const job = pipeline.repo.listJobs()[0];
    expect(run.status).toBe("success");
    expect(run.processed).toBe(1);
    expect(job?.job.location).toBe("Toronto, ON");
  });

  it("keeps discovery listings when strict keywords remove every extracted match", async () => {
    const sourceId = pipeline.registerSource({
      name: "Strict keyword source",
      sourceUrl: "https://example.com/jobs?location=Toronto%2C+ON",
      kind: "levels",
      regionId: "toronto-canada",
      active: true,
      usePersistentBrowser: false,
      metadata: { discoveryOnly: true, titleKeywords: ["data analyst"] }
    });
    const html = `
      <article>
        <a href="https://example.com/jobs/999">Apply</a>
        <h3>Senior Analytics Engineer</h3>
        <div class="location">Toronto, ON</div>
      </article>
    `;
    const run = await pipeline.syncRegisteredSource(sourceId, html);
    expect(run.status).toBe("success");
    expect(run.processed).toBe(1);
    expect(run.errors).toEqual([]);
  });

  it("does not trim Levels sources by title keywords", async () => {
    const sourceId = pipeline.registerSource({
      name: "Levels keyword bypass source",
      sourceUrl: "https://example.com/jobs?location=Toronto%2C+ON",
      kind: "levels",
      regionId: "toronto-canada",
      active: true,
      usePersistentBrowser: false,
      metadata: { discoveryOnly: true, titleKeywords: ["data analyst"] }
    });
    const html = `
      <article>
        <a href="https://example.com/jobs/111">Apply</a>
        <h3>Data Analyst</h3>
        <div class="location">Toronto, ON</div>
      </article>
      <article>
        <a href="https://example.com/jobs/222">Apply</a>
        <h3>Platform Engineer</h3>
        <div class="location">Toronto, ON</div>
      </article>
    `;
    const run = await pipeline.syncRegisteredSource(sourceId, html);
    expect(run.status).toBe("success");
    expect(run.processed).toBe(2);
    const jobs = pipeline.repo.listJobs();
    expect(jobs).toHaveLength(2);
  });
});
