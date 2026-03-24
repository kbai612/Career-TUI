import { z } from "zod";
import { APPLICATION_STATES, MODE_NAMES, RESUME_FEEDBACK_OUTCOMES, SCORE_DIMENSIONS } from "./types";

export const scoreDimensionSchema = z.enum(SCORE_DIMENSIONS);
export const applicationStateSchema = z.enum(APPLICATION_STATES);
export const modeNameSchema = z.enum(MODE_NAMES);
export const gradeSchema = z.enum(["A", "B", "C", "D", "E", "F"]);

export const jobListingSchema = z.object({
  id: z.number().optional(),
  portal: z.string(),
  sourceUrl: z.string().url(),
  applyUrl: z.string().url(),
  company: z.string(),
  title: z.string(),
  location: z.string(),
  postedAt: z.string().optional(),
  remotePolicy: z.string().optional(),
  compensationText: z.string().optional(),
  salaryMin: z.number().optional(),
  salaryMax: z.number().optional(),
  employmentType: z.string().optional(),
  externalId: z.string().optional(),
  description: z.string().optional(),
  rawHtml: z.string().optional(),
  metadata: z.record(z.unknown()).optional()
});

export const normalizedJobSchema = jobListingSchema.extend({
  fingerprint: z.string(),
  normalizedTitle: z.string(),
  normalizedCompany: z.string(),
  normalizedLocation: z.string(),
  visitedCount: z.number(),
  status: applicationStateSchema
});

export const evaluationDimensionScoreSchema = z.object({
  score: z.number().min(0).max(5),
  reasoning: z.string()
});

export const evaluationScoresSchema = z.object(
  Object.fromEntries(
    SCORE_DIMENSIONS.map((dimension) => [dimension, evaluationDimensionScoreSchema])
  ) as Record<string, typeof evaluationDimensionScoreSchema>
);

export const cvMatchEntrySchema = z.object({
  requirement: z.string(),
  proofPoint: z.string(),
  strength: z.enum(["Weak", "Moderate", "Strong", "Very Strong"]),
  notes: z.string()
});

export const gapMitigationSchema = z.object({
  gap: z.string(),
  severity: z.enum(["low", "medium", "high"]),
  mitigation: z.string()
});

export const levelStrategySchema = z.object({
  targetLevel: z.string(),
  positioning: z.string(),
  rationale: z.string(),
  risks: z.array(z.string())
});

export const compensationViewSchema = z.object({
  summary: z.string(),
  verdict: z.string(),
  notes: z.array(z.string())
});

export const personalizationViewSchema = z.object({
  language: z.enum(["English", "Spanish"]),
  format: z.enum(["Letter", "A4"]),
  keywords: z.array(z.string()),
  recommendedProjects: z.array(z.string()),
  summaryFocus: z.string()
});

export const interviewViewSchema = z.object({
  likelihood: z.number().min(0).max(100),
  rationale: z.string(),
  talkingPoints: z.array(z.string())
});

export const evaluationReportSchema = z.object({
  jobId: z.number().optional(),
  archetypeId: z.string(),
  archetypeLabel: z.string(),
  grade: gradeSchema,
  summary: z.string(),
  executiveSummary: z.string(),
  scores: evaluationScoresSchema,
  totalScore: z.number().min(0).max(5),
  recommendedAction: z.enum(["reject", "review", "apply"]),
  rejectionReasons: z.array(z.string()),
  matchedKeywords: z.array(z.string()),
  missingKeywords: z.array(z.string()),
  strongestSignals: z.array(z.string()),
  riskSignals: z.array(z.string()),
  cvMatches: z.array(cvMatchEntrySchema),
  gaps: z.array(gapMitigationSchema),
  levelStrategy: levelStrategySchema,
  compensationView: compensationViewSchema,
  personalization: personalizationViewSchema,
  interviewView: interviewViewSchema,
  generatedAt: z.string()
});

export const resumeSectionSchema = z.object({
  heading: z.string(),
  bullets: z.array(z.string()).min(1)
});

export const resumeVariantSchema = z.object({
  jobId: z.number(),
  title: z.string(),
  targetCompany: z.string(),
  summary: z.string(),
  keywords: z.array(z.string()),
  sections: z.array(resumeSectionSchema),
  plainText: z.string(),
  html: z.string(),
  htmlPath: z.string(),
  pdfPath: z.string(),
  coverLetterPlainText: z.string(),
  coverLetterHtml: z.string(),
  coverLetterHtmlPath: z.string(),
  coverLetterPdfPath: z.string(),
  generatedAt: z.string()
});

export const applicationDraftSchema = z.object({
  jobId: z.number(),
  targetUrl: z.string().url(),
  answers: z.record(z.string()),
  roleSpecificAnswers: z.array(z.string()),
  reviewRequired: z.literal(true),
  status: z.enum(["drafted", "reviewed", "submitted"]),
  generatedAt: z.string()
});

export const offerComparisonItemSchema = z.object({
  jobId: z.number(),
  company: z.string(),
  title: z.string(),
  totalScore: z.number().min(0).max(5),
  grade: gradeSchema,
  recommendedAction: z.enum(["reject", "review", "apply"]),
  strongestSignals: z.array(z.string()),
  mainRisk: z.string()
});

export const offerComparisonSchema = z.object({
  generatedAt: z.string(),
  summary: z.string(),
  ranking: z.array(offerComparisonItemSchema),
  shortlistIds: z.array(z.number())
});

export const deepResearchReportSchema = z.object({
  jobId: z.number(),
  company: z.string(),
  executiveSummary: z.string(),
  businessModel: z.string(),
  productSignals: z.array(z.string()),
  operatingSignals: z.array(z.string()),
  risks: z.array(z.string()),
  outreachAngles: z.array(z.string()),
  generatedAt: z.string()
});

export const contactDraftSchema = z.object({
  jobId: z.number(),
  company: z.string(),
  recipientType: z.enum(["recruiter", "hiring_manager", "peer"]),
  subject: z.string(),
  opener: z.string(),
  message: z.string(),
  talkingPoints: z.array(z.string()),
  generatedAt: z.string()
});

export const trainingAssessmentSchema = z.object({
  source: z.string(),
  score: z.number().min(0).max(5),
  verdict: z.enum(["pursue", "defer", "skip"]),
  targetArchetypes: z.array(z.string()),
  summary: z.string(),
  strengths: z.array(z.string()),
  gaps: z.array(z.string()),
  generatedAt: z.string()
});

export const autoPipelineResultSchema = z.object({
  jobIds: z.array(z.number()),
  evaluations: z.number(),
  resumes: z.array(z.string()),
  drafts: z.number(),
  rejected: z.number()
});

export const queueJobSchema = z.object({
  id: z.string(),
  mode: modeNameSchema,
  payload: z.record(z.unknown()),
  concurrencyKey: z.string(),
  createdAt: z.string()
});

export const runSummarySchema = z.object({
  mode: modeNameSchema,
  startedAt: z.string(),
  completedAt: z.string(),
  processed: z.number(),
  created: z.number(),
  updated: z.number(),
  errors: z.array(z.string()),
  jobIds: z.array(z.number()).optional()
});

export const excludedCompanySchema = z.object({
  id: z.number(),
  company: z.string(),
  companyKey: z.string(),
  reason: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string()
});

export const applicationAnswerMemorySchema = z.object({
  id: z.number(),
  questionKey: z.string(),
  answer: z.string(),
  tags: z.array(z.string()),
  usageCount: z.number().int().min(0),
  lastUsedAt: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string()
});

export const resumeFeedbackOutcomeSchema = z.enum(RESUME_FEEDBACK_OUTCOMES);

export const resumeVariantFeedbackSchema = z.object({
  id: z.number(),
  jobId: z.number(),
  outcome: resumeFeedbackOutcomeSchema,
  score: z.number().optional(),
  notes: z.string().optional(),
  company: z.string(),
  title: z.string(),
  resumeKeywords: z.array(z.string()),
  resumeGeneratedAt: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string()
});

export const agentSchemas = {
  "auto-pipeline": autoPipelineResultSchema,
  "scanner-discovery": z.object({ listings: z.array(jobListingSchema) }),
  "job-normalizer": normalizedJobSchema,
  "dedup-resolver": z.object({ fingerprint: z.string(), duplicateOf: z.number().nullable() }),
  "offer-evaluator": evaluationReportSchema,
  "offer-report": evaluationReportSchema,
  "offer-comparison": offerComparisonSchema,
  "resume-tailor": resumeVariantSchema.omit({
    html: true,
    htmlPath: true,
    pdfPath: true,
    plainText: true,
    coverLetterPlainText: true,
    coverLetterHtml: true,
    coverLetterHtmlPath: true,
    coverLetterPdfPath: true
  }),
  "pdf-renderer": z.object({ html: z.string(), pdfPath: z.string() }),
  "application-drafter": applicationDraftSchema,
  "apply-runner": z.object({ jobId: z.number(), reviewRequired: z.literal(true), submitted: z.boolean() }),
  "company-research": deepResearchReportSchema,
  "contact-drafter": contactDraftSchema,
  "training-evaluator": trainingAssessmentSchema
} as const;

export function validateAgentOutput<T>(schema: z.ZodType<T>, payload: unknown): T {
  return schema.parse(payload);
}

