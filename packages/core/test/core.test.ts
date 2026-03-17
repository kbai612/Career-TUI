import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildFingerprint, incrementVisitCount, normalizeListing } from "../src/dedup";
import { assertTransition, canTransition } from "../src/state-machine";
import { deterministicEvaluation, matchArchetype, recommendationForScore } from "../src/scoring";
import { applicationDraftSchema, evaluationReportSchema, validateAgentOutput } from "../src/schema";
import { buildResumeVariant } from "../src/resume";
import { buildApplicationDraft, ensureReviewRequired } from "../src/application";
import { CareerOpsPipeline } from "../src/pipeline";
import { ashbyAdapter, genericCareersAdapter, greenhouseAdapter, leverAdapter, workdayAdapter } from "../src/adapters";
import { loadArchetypeConfig, loadProfilePack, loadScoringConfig } from "../src/config";

const rootDir = path.resolve(__dirname, "..", "..", "..");
const readFixture = (name: string) => require("node:fs").readFileSync(path.resolve(__dirname, "fixtures", name), "utf8") as string;

describe("scoring and state", () => {
  const scoring = loadScoringConfig(rootDir);
  const archetypes = loadArchetypeConfig(rootDir).archetypes;
  const profile = loadProfilePack(rootDir);
  const job = {
    portal: "greenhouse",
    sourceUrl: "https://boards.greenhouse.io/example",
    applyUrl: "https://boards.greenhouse.io/example/jobs/123",
    company: "n8n",
    title: "Staff LLM Interaction Engineer",
    location: "Remote, United States",
    description: "Build agent workflows, evaluation systems, and Playwright automations.",
    salaryMin: 210000,
    salaryMax: 250000
  };

  it("builds stable fingerprints and enforces visit ceiling", () => {
    const one = buildFingerprint(job);
    const two = buildFingerprint({ ...job });
    expect(one).toBe(two);
    expect(() => incrementVisitCount(2)).toThrow(/Visited twice max/);
  });

  it("matches archetypes and recommendations", () => {
    const archetype = matchArchetype(job, archetypes);
    expect(archetype.id).toBe("ai-platform-llmops");
    expect(recommendationForScore(4.2, scoring)).toBe("apply");
  });

  it("computes deterministic evaluations", () => {
    const report = deterministicEvaluation(job, archetypes, scoring, profile);
    expect(report.totalScore).toBeGreaterThan(3.5);
    expect(report.recommendedAction).toBe("apply");
    expect(report.matchedKeywords.length).toBeGreaterThan(0);
  });

  it("guards state transitions", () => {
    expect(canTransition("normalized", "evaluated")).toBe(true);
    expect(() => assertTransition("discovered", "submitted")).toThrow(/Invalid state transition/);
  });
});

describe("schemas, adapters, resume, and apply draft", () => {
  it("validates evaluator schema", () => {
    const scoring = loadScoringConfig(rootDir);
    const archetypes = loadArchetypeConfig(rootDir).archetypes;
    const profile = loadProfilePack(rootDir);
    const report = deterministicEvaluation({
      portal: "generic",
      sourceUrl: "https://example.com",
      applyUrl: "https://example.com/job",
      company: "Acme",
      title: "Agent Platform Engineer",
      location: "Remote",
      description: "Build agent systems"
    }, archetypes, scoring, profile);
    expect(validateAgentOutput(evaluationReportSchema, report).summary).toContain("scores");
  });

  it("parses supported portal fixtures", () => {
    expect(greenhouseAdapter.discoverListings(readFixture("greenhouse.html"), "https://boards.greenhouse.io/example").length).toBe(1);
    expect(leverAdapter.discoverListings(readFixture("lever.html"), "https://jobs.lever.co/example")[0]?.title).toContain("Solutions");
    expect(ashbyAdapter.discoverListings(readFixture("ashby.html"), "https://jobs.ashbyhq.com/example")[0]?.company).toContain("jobs.ashbyhq.com");
    expect(workdayAdapter.discoverListings(readFixture("workday.html"), "https://company.workdayjobs.com/example").length).toBe(1);
    expect(genericCareersAdapter.discoverListings(readFixture("generic.html"), "https://company.com/careers")[0]?.salaryMin).toBe(200000);
  });

  it("builds ATS-safe resume variants", () => {
    const scoring = loadScoringConfig(rootDir);
    const archetypes = loadArchetypeConfig(rootDir).archetypes;
    const profile = loadProfilePack(rootDir);
    const report = deterministicEvaluation({
      portal: "generic",
      sourceUrl: "https://example.com",
      applyUrl: "https://example.com/job",
      company: "Acme",
      title: "Agent Platform Engineer",
      location: "Remote",
      description: "Playwright TypeScript OpenAI systems"
    }, archetypes, scoring, profile);
    const variant = buildResumeVariant(1, path.resolve(rootDir, "data", "test-resumes"), {
      portal: "generic",
      sourceUrl: "https://example.com",
      applyUrl: "https://example.com/job",
      company: "Acme",
      title: "Agent Platform Engineer",
      location: "Remote",
      description: "Playwright TypeScript OpenAI systems"
    }, report, profile);
    expect(variant.html).toContain("<html>");
    expect(variant.plainText).toContain("Agent Platform Engineer");
  });

  it("builds review-required application drafts", () => {
    const scoring = loadScoringConfig(rootDir);
    const archetypes = loadArchetypeConfig(rootDir).archetypes;
    const profile = loadProfilePack(rootDir);
    const report = deterministicEvaluation({
      portal: "generic",
      sourceUrl: "https://example.com",
      applyUrl: "https://example.com/job",
      company: "Acme",
      title: "Agent Platform Engineer",
      location: "Remote",
      description: "Playwright TypeScript OpenAI systems"
    }, archetypes, scoring, profile);
    const draft = buildApplicationDraft(1, {
      portal: "generic",
      sourceUrl: "https://example.com",
      applyUrl: "https://example.com/job",
      company: "Acme",
      title: "Agent Platform Engineer",
      location: "Remote",
      description: "Playwright TypeScript OpenAI systems"
    }, report, profile);
    ensureReviewRequired(draft);
    expect(validateAgentOutput(applicationDraftSchema, draft).reviewRequired).toBe(true);
  });
});

describe("pipeline", () => {
  let tempDir: string;
  let pipeline: CareerOpsPipeline;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(tmpdir(), "career-ops-"));
    pipeline = new CareerOpsPipeline(rootDir, path.resolve(tempDir, "career-ops.db"));
  });

  afterEach(() => {
    pipeline.dispose();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("runs a local acceptance flow", async () => {
    pipeline.seedDemoJobs([
      {
        portal: "greenhouse",
        sourceUrl: "https://boards.greenhouse.io/example",
        applyUrl: "https://boards.greenhouse.io/example/jobs/123",
        company: "n8n",
        title: "Staff LLM Interaction Engineer",
        location: "Remote, United States",
        postedAt: new Date().toISOString(),
        compensationText: "$210,000 - $250,000",
        salaryMin: 210000,
        salaryMax: 250000,
        description: "Build agent workflows and evaluation loops with TypeScript and Playwright."
      }
    ]);
    await pipeline.evaluatePending(10);
    const record = pipeline.repo.listJobs()[0];
    expect(record.evaluation?.recommendedAction).toBe("apply");
    pipeline.repo.updateJobStatus(record.job.id, "shortlisted");
    const pdfPath = await pipeline.generateResume(record.job.id);
    expect(pdfPath).toContain(".pdf");
    await pipeline.draftApplication(record.job.id);
    const refreshed = pipeline.repo.getJobRecord(record.job.id);
    expect(refreshed.application?.reviewRequired).toBe(true);
    expect(refreshed.job.status).toBe("ready_to_apply");
  });
});
