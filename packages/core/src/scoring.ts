import type { ArchetypeDefinition, EvaluationReport, EvaluationScores, JobListing, ProfilePack, ScoringConfig, ScoreDimension } from "./types";
import { SCORE_DIMENSIONS } from "./types";

function clampScore(value: number): number {
  return Math.max(0, Math.min(5, Number(value.toFixed(1))));
}

function tokenize(...inputs: Array<string | undefined>): string[] {
  return inputs
    .join(" ")
    .toLowerCase()
    .split(/[^a-z0-9+#]+/)
    .filter(Boolean);
}

export function matchArchetype(job: JobListing, archetypes: ArchetypeDefinition[]): ArchetypeDefinition {
  const tokens = new Set(tokenize(job.title, job.description, job.company));
  const best = archetypes
    .map((archetype) => ({
      archetype,
      score: archetype.keywords.reduce((sum, keyword) => sum + (tokens.has(keyword.toLowerCase()) ? 2 : 0), 0) +
        archetype.seniority.reduce((sum, seniority) => sum + (tokens.has(seniority.toLowerCase()) ? 1 : 0), 0)
    }))
    .sort((left, right) => right.score - left.score)[0];
  return best?.archetype ?? archetypes[0];
}

function keywordOverlap(job: JobListing, profile: ProfilePack): { matched: string[]; missing: string[] } {
  const tokens = new Set(tokenize(job.title, job.description, job.location, job.remotePolicy));
  const matched = profile.skills.filter((skill) => tokens.has(skill.toLowerCase().split(/[^a-z0-9+#]+/)[0] ?? ""));
  const missing = profile.skills.filter((skill) => !matched.includes(skill)).slice(0, 6);
  return { matched, missing };
}

function salaryScore(job: JobListing, profile: ProfilePack): number {
  if (job.salaryMax == null && job.salaryMin == null) {
    return 2.5;
  }
  const floor = job.salaryMax ?? job.salaryMin ?? 0;
  const ceiling = job.salaryMin ?? job.salaryMax ?? 0;
  if (floor >= profile.preferences.targetCompMinUsd) {
    return 4.5;
  }
  if (ceiling >= profile.preferences.targetCompMinUsd) {
    return 3.5;
  }
  return 1.8;
}

function geographicScore(job: JobListing, profile: ProfilePack): number {
  const haystack = `${job.location} ${job.remotePolicy ?? ""}`.toLowerCase();
  if (profile.preferences.remoteOnly && haystack.includes("remote")) {
    return 5;
  }
  if (profile.preferences.allowedRegions.some((region) => haystack.includes(region.toLowerCase()))) {
    return 4;
  }
  return 1.5;
}

function dimensionReasoning(dimension: ScoreDimension, score: number, job: JobListing): string {
  const phrases: Record<ScoreDimension, string> = {
    roleFit: "Title and domain proximity to target archetypes.",
    skillsAlignment: "Overlap between listing requirements and stored proof points.",
    seniorityCalibration: "Alignment between title seniority and target level.",
    compensationRange: "Match between disclosed compensation and target range.",
    geographicViability: "Compatibility with remote and region preferences.",
    companyStability: "Heuristic based on company naming and maturity cues.",
    productMarketInterest: "Interest inferred from domain language in the listing.",
    growthTrajectory: "Signals of expansion, platform ownership, or founding-stage leverage.",
    atsCompatibility: "Clarity and keyword density that benefit tailored ATS output.",
    timelineUrgency: "Urgency inferred from posted date and hiring phrasing."
  };
  return `${phrases[dimension]} Score ${score.toFixed(1)} for ${job.company}.`;
}

export function computeWeightedTotal(scores: EvaluationScores, config: ScoringConfig): number {
  let weighted = 0;
  let totalWeights = 0;
  for (const dimension of SCORE_DIMENSIONS) {
    weighted += scores[dimension].score * config.weights[dimension];
    totalWeights += config.weights[dimension];
  }
  return clampScore(weighted / totalWeights);
}

export function recommendationForScore(totalScore: number, config: ScoringConfig): "reject" | "review" | "apply" {
  if (totalScore < config.rejectThreshold) {
    return "reject";
  }
  if (totalScore >= config.shortlistThreshold) {
    return "apply";
  }
  return "review";
}

export function deterministicEvaluation(job: JobListing, archetypes: ArchetypeDefinition[], config: ScoringConfig, profile: ProfilePack): EvaluationReport {
  const archetype = matchArchetype(job, archetypes);
  const overlap = keywordOverlap(job, profile);
  const titleTokens = tokenize(job.title);
  const scores = Object.fromEntries(
    SCORE_DIMENSIONS.map((dimension) => {
      let value = 3;
      switch (dimension) {
        case "roleFit":
          value = 2 + Math.min(3, overlap.matched.length * 0.5 + archetype.keywords.filter((keyword) => titleTokens.includes(keyword)).length * 0.6);
          break;
        case "skillsAlignment":
          value = 1.5 + Math.min(3.5, overlap.matched.length * 0.6);
          break;
        case "seniorityCalibration":
          value = /staff|principal|senior/i.test(job.title) ? 4.2 : /lead|manager/i.test(job.title) ? 2.6 : 3.2;
          break;
        case "compensationRange":
          value = salaryScore(job, profile);
          break;
        case "geographicViability":
          value = geographicScore(job, profile);
          break;
        case "companyStability":
          value = /labs|inc|corp|platform|systems/i.test(job.company) ? 3.7 : 3.1;
          break;
        case "productMarketInterest":
          value = /ai|automation|platform|developer|agent/i.test(job.description ?? job.title) ? 4.2 : 2.9;
          break;
        case "growthTrajectory":
          value = /build|founding|scale|launch|own/i.test(job.description ?? "") ? 4 : 2.8;
          break;
        case "atsCompatibility":
          value = job.description && job.description.length > 120 ? 4.1 : 2.4;
          break;
        case "timelineUrgency":
          value = job.postedAt ? 4.1 : 2.7;
          break;
      }
      const score = clampScore(value);
      return [dimension, { score, reasoning: dimensionReasoning(dimension, score, job) }];
    })
  ) as EvaluationScores;

  const totalScore = computeWeightedTotal(scores, config);
  const recommendedAction = recommendationForScore(totalScore, config);
  const rejectionReasons = recommendedAction === "reject"
    ? [
        scores.geographicViability.score < 2.5 ? "Geography is outside configured preferences." : "",
        scores.compensationRange.score < 2.5 ? "Compensation falls below target range or is too uncertain." : "",
        scores.skillsAlignment.score < 2.5 ? "Insufficient skills overlap for efficient tailoring." : ""
      ].filter(Boolean)
    : [];

  return {
    archetypeId: archetype.id,
    archetypeLabel: archetype.label,
    summary: `${job.title} at ${job.company} scores ${totalScore.toFixed(1)}/5 with strongest signal in ${overlap.matched[0] ?? archetype.label}.`,
    scores,
    totalScore,
    recommendedAction,
    rejectionReasons,
    matchedKeywords: overlap.matched,
    missingKeywords: overlap.missing,
    generatedAt: new Date().toISOString()
  };
}
