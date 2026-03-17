export const SCORE_DIMENSIONS = [
  "roleFit",
  "skillsAlignment",
  "seniorityCalibration",
  "compensationRange",
  "geographicViability",
  "companyStability",
  "productMarketInterest",
  "growthTrajectory",
  "atsCompatibility",
  "timelineUrgency"
] as const;

export type ScoreDimension = (typeof SCORE_DIMENSIONS)[number];

export const APPLICATION_STATES = [
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
] as const;

export type ApplicationState = (typeof APPLICATION_STATES)[number];

export const MODE_NAMES = [
  "scanner-discovery",
  "job-normalizer",
  "dedup-resolver",
  "offer-evaluator",
  "resume-tailor",
  "pdf-renderer",
  "application-drafter",
  "apply-runner"
] as const;

export type ModeName = (typeof MODE_NAMES)[number];

export type ActionRecommendation = "reject" | "review" | "apply";

export interface JobListing {
  id?: number;
  portal: string;
  sourceUrl: string;
  applyUrl: string;
  company: string;
  title: string;
  location: string;
  postedAt?: string;
  remotePolicy?: string;
  compensationText?: string;
  salaryMin?: number;
  salaryMax?: number;
  employmentType?: string;
  externalId?: string;
  description?: string;
  rawHtml?: string;
  metadata?: Record<string, unknown>;
}

export interface NormalizedJob extends JobListing {
  fingerprint: string;
  normalizedTitle: string;
  normalizedCompany: string;
  normalizedLocation: string;
  visitedCount: number;
  status: ApplicationState;
}

export interface EvaluationDimensionScore {
  score: number;
  reasoning: string;
}

export type EvaluationScores = Record<ScoreDimension, EvaluationDimensionScore>;

export interface EvaluationReport {
  jobId?: number;
  archetypeId: string;
  archetypeLabel: string;
  summary: string;
  scores: EvaluationScores;
  totalScore: number;
  recommendedAction: ActionRecommendation;
  rejectionReasons: string[];
  matchedKeywords: string[];
  missingKeywords: string[];
  generatedAt: string;
}

export interface ResumeSection {
  heading: string;
  bullets: string[];
}

export interface ResumeVariant {
  jobId: number;
  title: string;
  targetCompany: string;
  summary: string;
  keywords: string[];
  sections: ResumeSection[];
  plainText: string;
  html: string;
  htmlPath: string;
  pdfPath: string;
  generatedAt: string;
}

export interface ApplicationDraft {
  jobId: number;
  targetUrl: string;
  answers: Record<string, string>;
  roleSpecificAnswers: string[];
  reviewRequired: true;
  status: "drafted" | "reviewed" | "submitted";
  generatedAt: string;
}

export interface QueueJob {
  id: string;
  mode: ModeName;
  payload: Record<string, unknown>;
  concurrencyKey: string;
  createdAt: string;
}

export interface RunSummary {
  mode: ModeName;
  startedAt: string;
  completedAt: string;
  processed: number;
  created: number;
  updated: number;
  errors: string[];
}

export interface ScoringConfig {
  weights: Record<ScoreDimension, number>;
  rejectThreshold: number;
  shortlistThreshold: number;
  topThreshold: number;
}

export interface ArchetypeDefinition {
  id: string;
  label: string;
  keywords: string[];
  seniority: string[];
}

export interface ArchetypeConfig {
  archetypes: ArchetypeDefinition[];
}

export interface ProfilePack {
  name: string;
  email: string;
  phone: string;
  location: string;
  linkedin?: string;
  github?: string;
  portfolio?: string;
  summary: string;
  skills: string[];
  proofPoints: string[];
  preferences: {
    remoteOnly: boolean;
    allowedRegions: string[];
    targetCompMinUsd: number;
    targetCompMaxUsd: number;
  };
  eeo: Record<string, string>;
  masterResume: string;
}

export interface PortalAdapter {
  portal: string;
  matches(sourceUrl: string): boolean;
  discoverListings(html: string, sourceUrl: string): JobListing[];
}

export interface StoredJobRecord {
  id: number;
  fingerprint: string;
  portal: string;
  sourceUrl: string;
  applyUrl: string;
  company: string;
  title: string;
  location: string;
  postedAt?: string;
  remotePolicy?: string;
  compensationText?: string;
  salaryMin?: number;
  salaryMax?: number;
  employmentType?: string;
  externalId?: string;
  rawJson: string;
  normalizedJson: string;
  status: ApplicationState;
  visitCount: number;
  createdAt: string;
  updatedAt: string;
}
