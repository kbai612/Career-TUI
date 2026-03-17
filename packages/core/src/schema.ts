import { z } from "zod";
import { APPLICATION_STATES, MODE_NAMES, SCORE_DIMENSIONS } from "./types";

export const scoreDimensionSchema = z.enum(SCORE_DIMENSIONS);
export const applicationStateSchema = z.enum(APPLICATION_STATES);
export const modeNameSchema = z.enum(MODE_NAMES);

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

export const evaluationReportSchema = z.object({
  jobId: z.number().optional(),
  archetypeId: z.string(),
  archetypeLabel: z.string(),
  summary: z.string(),
  scores: evaluationScoresSchema,
  totalScore: z.number().min(0).max(5),
  recommendedAction: z.enum(["reject", "review", "apply"]),
  rejectionReasons: z.array(z.string()),
  matchedKeywords: z.array(z.string()),
  missingKeywords: z.array(z.string()),
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
  errors: z.array(z.string())
});

export const agentSchemas = {
  "scanner-discovery": z.object({ listings: z.array(jobListingSchema) }),
  "job-normalizer": normalizedJobSchema,
  "dedup-resolver": z.object({ fingerprint: z.string(), duplicateOf: z.number().nullable() }),
  "offer-evaluator": evaluationReportSchema,
  "resume-tailor": resumeVariantSchema.omit({ html: true, htmlPath: true, pdfPath: true, plainText: true }),
  "pdf-renderer": z.object({ html: z.string(), pdfPath: z.string() }),
  "application-drafter": applicationDraftSchema,
  "apply-runner": z.object({ jobId: z.number(), reviewRequired: z.literal(true), submitted: z.boolean() })
} as const;

export function validateAgentOutput<T>(schema: z.ZodType<T>, payload: unknown): T {
  return schema.parse(payload);
}
