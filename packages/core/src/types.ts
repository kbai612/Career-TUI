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
  "auto-pipeline",
  "scanner-discovery",
  "job-normalizer",
  "dedup-resolver",
  "offer-evaluator",
  "offer-report",
  "offer-comparison",
  "resume-tailor",
  "pdf-renderer",
  "application-drafter",
  "apply-runner",
  "company-research",
  "contact-drafter",
  "training-evaluator"
] as const;

export type ModeName = (typeof MODE_NAMES)[number];

export type ActionRecommendation = "reject" | "review" | "apply";

export const SOURCE_KINDS = [
  "greenhouse",
  "lever",
  "ashby",
  "workday",
  "generic",
  "linkedin",
  "levels"
] as const;

export type SourceKind = (typeof SOURCE_KINDS)[number];

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

export interface CareerSource {
  id?: number;
  name: string;
  sourceUrl: string;
  kind: SourceKind;
  regionId: string;
  active: boolean;
  usePersistentBrowser: boolean;
  metadata?: Record<string, unknown>;
  lastSyncedAt?: string;
  lastStatus?: "idle" | "success" | "error";
}

export interface StoredCareerSource extends CareerSource {
  id: number;
  metadataJson: string;
  createdAt: string;
  updatedAt: string;
}

export interface SourceSyncRun {
  sourceId: number;
  sourceName: string;
  sourceUrl: string;
  regionId: string;
  startedAt: string;
  completedAt: string;
  processed: number;
  created: number;
  updated: number;
  errors: string[];
  status: "success" | "error";
  jobIds: number[];
}

export interface RegionRule {
  id: string;
  label: string;
  aliases: string[];
  remoteAliases: string[];
}

export interface RegionConfig {
  regions: RegionRule[];
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

export interface CvMatchEntry {
  requirement: string;
  proofPoint: string;
  strength: "Weak" | "Moderate" | "Strong" | "Very Strong";
  notes: string;
}

export interface GapMitigation {
  gap: string;
  severity: "low" | "medium" | "high";
  mitigation: string;
}

export interface LevelStrategyBlock {
  targetLevel: string;
  positioning: string;
  rationale: string;
  risks: string[];
}

export interface CompensationView {
  summary: string;
  verdict: string;
  notes: string[];
}

export interface PersonalizationView {
  language: "English" | "Spanish";
  format: "Letter" | "A4";
  keywords: string[];
  recommendedProjects: string[];
  summaryFocus: string;
}

export interface InterviewView {
  likelihood: number;
  rationale: string;
  talkingPoints: string[];
}

export interface EvaluationReport {
  jobId?: number;
  archetypeId: string;
  archetypeLabel: string;
  grade: "A" | "B" | "C" | "D" | "E" | "F";
  summary: string;
  executiveSummary: string;
  scores: EvaluationScores;
  totalScore: number;
  recommendedAction: ActionRecommendation;
  rejectionReasons: string[];
  matchedKeywords: string[];
  missingKeywords: string[];
  strongestSignals: string[];
  riskSignals: string[];
  cvMatches: CvMatchEntry[];
  gaps: GapMitigation[];
  levelStrategy: LevelStrategyBlock;
  compensationView: CompensationView;
  personalization: PersonalizationView;
  interviewView: InterviewView;
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
  coverLetterPlainText: string;
  coverLetterHtml: string;
  coverLetterHtmlPath: string;
  coverLetterPdfPath: string;
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

export interface OfferComparisonItem {
  jobId: number;
  company: string;
  title: string;
  totalScore: number;
  grade: "A" | "B" | "C" | "D" | "E" | "F";
  recommendedAction: ActionRecommendation;
  strongestSignals: string[];
  mainRisk: string;
}

export interface OfferComparison {
  generatedAt: string;
  summary: string;
  ranking: OfferComparisonItem[];
  shortlistIds: number[];
}

export interface DeepResearchReport {
  jobId: number;
  company: string;
  executiveSummary: string;
  businessModel: string;
  productSignals: string[];
  operatingSignals: string[];
  risks: string[];
  outreachAngles: string[];
  generatedAt: string;
}

export interface ContactDraft {
  jobId: number;
  company: string;
  recipientType: "recruiter" | "hiring_manager" | "peer";
  subject: string;
  opener: string;
  message: string;
  talkingPoints: string[];
  generatedAt: string;
}

export interface TrainingAssessment {
  source: string;
  score: number;
  verdict: "pursue" | "defer" | "skip";
  targetArchetypes: string[];
  summary: string;
  strengths: string[];
  gaps: string[];
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
  jobIds?: number[];
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

