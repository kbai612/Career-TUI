import type {
  ArchetypeDefinition,
  ContactDraft,
  CvMatchEntry,
  DeepResearchReport,
  EvaluationReport,
  EvaluationScores,
  GapMitigation,
  JobListing,
  OfferComparison,
  OfferComparisonItem,
  PersonalizationView,
  ProfilePack,
  ScoringConfig,
  ScoreDimension,
  TrainingAssessment
} from "./types";
import { SCORE_DIMENSIONS } from "./types";

function clampScore(value: number): number {
  return Math.max(0, Math.min(5, Number(value.toFixed(2))));
}

function tokenize(...inputs: Array<string | undefined>): string[] {
  return inputs
    .join(" ")
    .toLowerCase()
    .split(/[^a-z0-9+#]+/)
    .filter(Boolean);
}

function unique<T>(items: T[]): T[] {
  return Array.from(new Set(items));
}

function sentenceCase(value: string): string {
  const trimmed = value.trim().replace(/\s+/g, " ");
  if (!trimmed) {
    return trimmed;
  }
  return trimmed[0].toUpperCase() + trimmed.slice(1);
}

function strengthLabel(score: number): CvMatchEntry["strength"] {
  if (score >= 4.5) {
    return "Very Strong";
  }
  if (score >= 4) {
    return "Strong";
  }
  if (score >= 3) {
    return "Moderate";
  }
  return "Weak";
}

function severityForScore(score: number): GapMitigation["severity"] {
  if (score < 2.2) {
    return "high";
  }
  if (score < 3.2) {
    return "medium";
  }
  return "low";
}

function detectLanguage(job: JobListing): PersonalizationView["language"] {
  const haystack = `${job.title} ${job.description ?? ""}`.toLowerCase();
  if (/[áéíóúñ]/i.test(haystack) || /\b(remoto|ingeniero|oferta|empresa|equipo|producto)\b/i.test(haystack)) {
    return "Spanish";
  }
  return "English";
}

function detectFormat(job: JobListing): PersonalizationView["format"] {
  const haystack = `${job.location} ${job.remotePolicy ?? ""} ${job.compensationText ?? ""}`.toLowerCase();
  return /united states|us\b|usa|\$/.test(haystack) ? "Letter" : "A4";
}

function extractRequirementPhrases(job: JobListing, archetype: ArchetypeDefinition, matchedKeywords: string[]): string[] {
  const sentences = (job.description ?? "")
    .split(/[.!?\n]/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length >= 24)
    .filter((sentence) => /build|design|own|lead|deliver|implement|automation|platform|stakeholder|customer|evaluation|agent|llm/i.test(sentence));

  const fallback = [
    `Deliver ${job.title} outcomes with measurable production impact.`,
    `Own high-leverage ${archetype.label.toLowerCase()} workflows.`,
    `Translate role requirements into reliable execution and review loops.`,
    `Work across product, engineering, and hiring stakeholders.`,
    ...matchedKeywords.map((keyword) => `Demonstrate depth in ${keyword}.`)
  ];

  return unique(sentences.concat(fallback).map(sentenceCase)).slice(0, 6);
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
    return 4.6;
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
    roleFit: "Title and domain proximity to the strongest archetype.",
    skillsAlignment: "Requirement overlap against stored profile skills and proof points.",
    seniorityCalibration: "Title seniority relative to the target positioning strategy.",
    compensationRange: "Disclosed or inferred compensation relative to configured targets.",
    geographicViability: "Compatibility with remote and regional constraints.",
    companyStability: "Heuristic stability signal from naming, maturity, and operating cues.",
    productMarketInterest: "Problem-domain resonance with the portfolio and North Star roles.",
    growthTrajectory: "Signals of scope, ownership, and career compounding.",
    atsCompatibility: "How cleanly the role can be mirrored in an ATS-safe resume.",
    timelineUrgency: "Hiring speed inferred from freshness and urgency language."
  };
  return `${phrases[dimension]} Score ${score.toFixed(1)} for ${job.company}.`;
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

export function scoreToGrade(totalScore: number): EvaluationReport["grade"] {
  if (totalScore >= 4.5) {
    return "A";
  }
  if (totalScore >= 4.0) {
    return "B";
  }
  if (totalScore >= 3.0) {
    return "C";
  }
  if (totalScore >= 2.5) {
    return "D";
  }
  if (totalScore >= 2.0) {
    return "E";
  }
  return "F";
}

export function isRichEvaluationReport(value: unknown): value is EvaluationReport {
  const report = value as Partial<EvaluationReport> | null;
  return report != null
    && typeof report.grade === "string"
    && typeof report.executiveSummary === "string"
    && Array.isArray(report.strongestSignals)
    && Array.isArray(report.riskSignals)
    && Array.isArray(report.cvMatches)
    && Array.isArray(report.gaps)
    && typeof report.levelStrategy === "object"
    && typeof report.compensationView === "object"
    && typeof report.personalization === "object"
    && typeof report.interviewView === "object";
}

function buildCvMatches(job: JobListing, profile: ProfilePack, archetype: ArchetypeDefinition, matchedKeywords: string[], scores: EvaluationScores): CvMatchEntry[] {
  const requirements = extractRequirementPhrases(job, archetype, matchedKeywords);
  return requirements.map((requirement, index) => {
    const proofPoint = profile.proofPoints[index % profile.proofPoints.length];
    const requirementTokens = new Set(tokenize(requirement));
    const proofTokens = tokenize(proofPoint);
    const overlap = proofTokens.filter((token) => requirementTokens.has(token)).length;
    const baseScore = Math.max(scores.roleFit.score, scores.skillsAlignment.score) - (index * 0.12);
    const strength = strengthLabel(baseScore + overlap * 0.2);
    return {
      requirement,
      proofPoint,
      strength,
      notes: `${strength} evidence based on reusable proof points and ${matchedKeywords[index % Math.max(matchedKeywords.length, 1)] ?? archetype.label}.`
    };
  });
}

function buildGaps(job: JobListing, profile: ProfilePack, missingKeywords: string[], scores: EvaluationScores): GapMitigation[] {
  const seededGaps = missingKeywords.slice(0, 3).map((keyword, index) => ({
    gap: `Explicit proof for ${keyword} is not obvious in the current profile pack.`,
    severity: severityForScore(scores.skillsAlignment.score - index * 0.4),
    mitigation: `Address ${keyword} with a concrete bullet, project link, or interview story tied to ${profile.proofPoints[index % profile.proofPoints.length]}.`
  }));

  if (scores.seniorityCalibration.score < 3.2) {
    seededGaps.push({
      gap: `The title may stretch or compress the current positioning for ${job.title}.`,
      severity: severityForScore(scores.seniorityCalibration.score),
      mitigation: "Frame scope honestly: emphasize systems ownership, measurable outcomes, and cross-functional influence without inflating headcount or formal title."
    });
  }

  return seededGaps.slice(0, 4);
}

function buildLevelStrategy(job: JobListing, reportScore: number, scores: EvaluationScores): EvaluationReport["levelStrategy"] {
  const targetLevel = /principal/i.test(job.title)
    ? "Principal / Staff+"
    : /staff/i.test(job.title)
      ? "Staff"
      : /senior/i.test(job.title)
        ? "Senior"
        : /lead|manager/i.test(job.title)
          ? "Lead"
          : "Mid-Senior";

  const positioning = scores.seniorityCalibration.score >= 4
    ? `Sell direct fit for ${targetLevel} scope without qualification.`
    : scores.seniorityCalibration.score >= 3
      ? `Position as adjacent to ${targetLevel}; lead with scope, ambiguity handling, and systems ownership.`
      : `Treat ${targetLevel} as a stretch and focus on the closest transferable platform or automation experience.`;

  return {
    targetLevel,
    positioning,
    rationale: `${job.title} maps to ${targetLevel}. The score of ${reportScore.toFixed(1)}/5 supports an honest framing around leverage, automation depth, and cross-functional delivery.`,
    risks: [
      scores.seniorityCalibration.score < 3 ? "Seniority gap requires careful framing." : "Level fit is credible.",
      scores.roleFit.score < 3.2 ? "Role semantics diverge from the strongest archetype." : "Role title aligns with the archetype.",
      scores.companyStability.score < 3 ? "Company context is ambiguous and may require more diligence." : "Company context looks workable for the target narrative."
    ]
  };
}

function buildCompensationView(job: JobListing, profile: ProfilePack, score: number): EvaluationReport["compensationView"] {
  const disclosed = job.compensationText ?? "Compensation not disclosed.";
  const verdict = score >= 4
    ? "Compensation likely supports the target range."
    : score >= 3
      ? "Compensation is viable but should be validated early."
      : "Compensation is a material risk for this role.";

  return {
    summary: `${disclosed} Target range is $${profile.preferences.targetCompMinUsd.toLocaleString()}-$${profile.preferences.targetCompMaxUsd.toLocaleString()}.`,
    verdict,
    notes: [
      job.salaryMin != null || job.salaryMax != null ? "Range was parsed from the listing." : "No structured range was available in the listing.",
      score < 3 ? "Ask for range before investing in heavy interview prep." : "Range is not a blocker at current signal quality.",
      /equity|bonus/i.test(job.compensationText ?? "") ? "Variable comp language appears in the listing." : "No explicit variable compensation signal was found."
    ]
  };
}

function buildPersonalization(job: JobListing, report: Pick<EvaluationReport, "archetypeLabel" | "matchedKeywords">, profile: ProfilePack): EvaluationReport["personalization"] {
  const language = detectLanguage(job);
  const format = detectFormat(job);
  const recommendedProjects = profile.proofPoints
    .slice(0, 3)
    .map((point) => point.split(".")[0]?.trim() ?? point)
    .filter(Boolean);

  return {
    language,
    format,
    keywords: unique(report.matchedKeywords.concat(tokenize(job.title).slice(0, 4))).slice(0, 8),
    recommendedProjects,
    summaryFocus: `Lead with ${report.archetypeLabel}, then reinforce ${report.matchedKeywords.slice(0, 3).join(", ") || "automation, evaluation, and delivery"}.`
  };
}

function buildInterviewView(job: JobListing, totalScore: number, scores: EvaluationScores, profile: ProfilePack): EvaluationReport["interviewView"] {
  const likelihood = Math.round(Math.max(10, Math.min(96, totalScore * 18 + scores.roleFit.score * 5 + scores.skillsAlignment.score * 4 - scores.geographicViability.score)));
  const talkingPoints = [
    `${profile.proofPoints[0]} This maps directly to ${job.title}.`,
    `Explain how the human-in-the-loop design reduces operational risk for ${job.company}.`,
    `Use one concrete story on Playwright, evaluation loops, or system ownership depending on the interviewer focus.`
  ];

  return {
    likelihood,
    rationale: `Interview odds track most strongly with role fit (${scores.roleFit.score.toFixed(1)}) and skills alignment (${scores.skillsAlignment.score.toFixed(1)}).`,
    talkingPoints
  };
}

function strongestSignals(scores: EvaluationScores): string[] {
  return SCORE_DIMENSIONS
    .map((dimension) => ({ dimension, score: scores[dimension].score }))
    .sort((left, right) => right.score - left.score)
    .slice(0, 3)
    .map(({ dimension, score }) => `${dimension} ${score.toFixed(1)}/5`);
}

function riskSignals(scores: EvaluationScores, missingKeywords: string[]): string[] {
  return unique(
    SCORE_DIMENSIONS
      .filter((dimension) => scores[dimension].score < 3)
      .map((dimension) => `${dimension} is below threshold at ${scores[dimension].score.toFixed(1)}/5`)
      .concat(missingKeywords.slice(0, 2).map((keyword) => `Evidence for ${keyword} is thin in the current profile pack.`))
  ).slice(0, 4);
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
          value = /staff|principal/i.test(job.title) ? 4.2 : /lead|manager/i.test(job.title) ? 2.8 : /senior/i.test(job.title) ? 4.0 : 3.2;
          break;
        case "compensationRange":
          value = salaryScore(job, profile);
          break;
        case "geographicViability":
          value = geographicScore(job, profile);
          break;
        case "companyStability":
          value = /labs|inc|corp|platform|systems|cloud/i.test(job.company) ? 3.8 : 3.1;
          break;
        case "productMarketInterest":
          value = /ai|automation|platform|developer|agent|workflow|llm/i.test(job.description ?? job.title) ? 4.3 : 2.9;
          break;
        case "growthTrajectory":
          value = /build|founding|scale|launch|own|greenfield/i.test(job.description ?? "") ? 4.1 : 2.9;
          break;
        case "atsCompatibility":
          value = job.description && job.description.length > 120 ? 4.2 : 2.5;
          break;
        case "timelineUrgency":
          value = job.postedAt ? 4.1 : /urgent|immediately|asap|hiring now/i.test(job.description ?? "") ? 4.0 : 2.8;
          break;
      }
      const score = clampScore(value);
      return [dimension, { score, reasoning: dimensionReasoning(dimension, score, job) }];
    })
  ) as EvaluationScores;

  const totalScore = computeWeightedTotal(scores, config);
  const grade = scoreToGrade(totalScore);
  const recommendedAction = recommendationForScore(totalScore, config);
  const rejectionReasons = recommendedAction === "reject"
    ? [
        scores.roleFit.score < 2.7 ? "Role fit is too far from the current North Star." : "",
        scores.geographicViability.score < 2.5 ? "Geography is outside configured preferences." : "",
        scores.compensationRange.score < 2.5 ? "Compensation falls below target range or is too uncertain." : "",
        scores.skillsAlignment.score < 2.7 ? "Skills overlap is too weak for efficient tailoring." : ""
      ].filter(Boolean)
    : [];

  const cvMatches = buildCvMatches(job, profile, archetype, overlap.matched, scores);
  const gaps = buildGaps(job, profile, overlap.missing, scores);
  const report: EvaluationReport = {
    archetypeId: archetype.id,
    archetypeLabel: archetype.label,
    grade,
    summary: `${job.title} at ${job.company} scores ${totalScore.toFixed(1)}/5 (${grade}) with strongest signal in ${overlap.matched[0] ?? archetype.label}.`,
    executiveSummary: `${job.title} at ${job.company} is a ${grade}-grade opportunity for the ${archetype.label} track. The role is strongest on ${strongestSignals(scores).join(", ")} and should be ${recommendedAction === "apply" ? "shortlisted" : recommendedAction === "review" ? "reviewed manually" : "rejected"} based on the current profile pack.`,
    scores,
    totalScore,
    recommendedAction,
    rejectionReasons,
    matchedKeywords: overlap.matched,
    missingKeywords: overlap.missing,
    strongestSignals: strongestSignals(scores),
    riskSignals: riskSignals(scores, overlap.missing),
    cvMatches,
    gaps,
    levelStrategy: buildLevelStrategy(job, totalScore, scores),
    compensationView: buildCompensationView(job, profile, scores.compensationRange.score),
    personalization: buildPersonalization(job, { archetypeLabel: archetype.label, matchedKeywords: overlap.matched }, profile),
    interviewView: buildInterviewView(job, totalScore, scores, profile),
    generatedAt: new Date().toISOString()
  };

  return report;
}

export function buildOfferComparison(reports: Array<{ jobId: number; company: string; title: string; report: EvaluationReport }>): OfferComparison {
  const ranking = reports
    .map(({ jobId, company, title, report }) => ({
      jobId,
      company,
      title,
      totalScore: report.totalScore,
      grade: report.grade,
      recommendedAction: report.recommendedAction,
      strongestSignals: report.strongestSignals ?? [],
      mainRisk: report.riskSignals?.[0] ?? "No material risk captured."
    }))
    .sort((left, right) => right.totalScore - left.totalScore) as OfferComparisonItem[];

  return {
    generatedAt: new Date().toISOString(),
    summary: ranking.length === 0
      ? "No evaluated offers were available for comparison."
      : `Top ranked offer: ${ranking[0].company} ${ranking[0].title} at ${ranking[0].totalScore.toFixed(1)}/5. ${ranking.filter((item) => item.recommendedAction === "apply").length} offers are currently in apply territory.`,
    ranking,
    shortlistIds: ranking.filter((item) => item.recommendedAction === "apply").map((item) => item.jobId)
  };
}

function inferDomain(job: JobListing, report: EvaluationReport): string {
  const haystack = `${job.title} ${job.description ?? ""} ${report.archetypeLabel}`.toLowerCase();
  if (/voice|speech|call|phone/.test(haystack)) {
    return "voice and conversational AI";
  }
  if (/platform|infra|llmops|evaluation|registry/.test(haystack)) {
    return "AI platform and infrastructure";
  }
  if (/solutions|customer|pre-sales|deployment/.test(haystack)) {
    return "solutions engineering and customer delivery";
  }
  if (/product|growth|experimentation/.test(haystack)) {
    return "product-led AI delivery";
  }
  return "AI automation and developer tooling";
}

export function buildDeepResearchReport(jobId: number, job: JobListing, report: EvaluationReport, profile: ProfilePack): DeepResearchReport {
  const domain = inferDomain(job, report);
  const remoteSignal = /remote/i.test(`${job.location} ${job.remotePolicy ?? ""}`) ? "Remote-friendly hiring is a positive execution signal." : "Location constraints may slow funnel velocity.";

  return {
    jobId,
    company: job.company,
    executiveSummary: `${job.company} appears to be investing in ${domain}. The role maps to ${report.archetypeLabel} and looks most attractive when the team values measurable automation wins over narrow specialization.`,
    businessModel: `${job.company} is inferred to be building in ${domain} based on the role language, scope, and hiring signals present in the listing.`,
    productSignals: [
      `Role language emphasizes ${report.archetypeLabel.toLowerCase()} ownership rather than isolated task execution.`,
      `Keyword density suggests interest in ${report.personalization.keywords.slice(0, 3).join(", ") || "automation and AI systems"}.`,
      `The listing can support an ATS narrative focused on ${report.personalization.summaryFocus.toLowerCase()}.`
    ],
    operatingSignals: [
      remoteSignal,
      job.postedAt ? `Fresh posting detected at ${job.postedAt}.` : "Posting freshness was not available.",
      report.recommendedAction === "apply" ? "Current score supports active pursuit." : "Current score suggests selective follow-up only."
    ],
    risks: report.riskSignals.length > 0 ? report.riskSignals : ["Public listing signals are limited; verify org chart and comp early."],
    outreachAngles: [
      `Lead with ${profile.proofPoints[0]}`,
      `Connect the role to ${report.archetypeLabel} and human-in-the-loop delivery discipline.`,
      `Use ${report.personalization.recommendedProjects[0] ?? "a relevant proof point"} as the concrete evidence anchor.`
    ],
    generatedAt: new Date().toISOString()
  };
}

export function buildOutreachDraft(jobId: number, job: JobListing, report: EvaluationReport, profile: ProfilePack): ContactDraft {
  const subject = `${job.title}: relevant ${report.archetypeLabel} background`;
  const opener = `I have been evaluating ${job.company}'s ${job.title} role and the overlap with my production work is unusually direct.`;
  const talkingPoints = [
    profile.proofPoints[0],
    `Direct alignment with ${report.archetypeLabel}.`,
    `Current fit score: ${report.totalScore.toFixed(1)}/5 (${report.grade}).`
  ];
  const message = [
    `Hi,`,
    ``,
    opener,
    ``,
    `The closest proof point is ${profile.proofPoints[0]}`,
    `I also bring experience in ${report.personalization.keywords.slice(0, 4).join(", ") || "automation, evaluation, and delivery"}, which maps well to the role's scope.`,
    ``,
    `If helpful, I can share the tailored resume and a concise breakdown of where I think I can contribute quickly.`,
    ``,
    `Best,`,
    profile.name
  ].join("\n");

  return {
    jobId,
    company: job.company,
    recipientType: "recruiter",
    subject,
    opener,
    message,
    talkingPoints,
    generatedAt: new Date().toISOString()
  };
}

export function buildTrainingAssessment(source: string, archetypes: ArchetypeDefinition[], profile: ProfilePack): TrainingAssessment {
  const tokens = new Set(tokenize(source));
  const rankedArchetypes = archetypes
    .map((archetype) => ({
      archetype,
      score: archetype.keywords.reduce((sum, keyword) => sum + (tokens.has(keyword.toLowerCase()) ? 1 : 0), 0)
    }))
    .sort((left, right) => right.score - left.score);
  const topArchetypes = rankedArchetypes.filter((item) => item.score > 0).slice(0, 2).map((item) => item.archetype.label);
  const skillHits = profile.skills.filter((skill) => tokens.has(skill.toLowerCase().split(/[^a-z0-9+#]+/)[0] ?? ""));
  const score = clampScore(2 + Math.min(2.8, topArchetypes.length * 0.9 + skillHits.length * 0.2));
  const verdict = score >= 4 ? "pursue" : score >= 2.8 ? "defer" : "skip";

  return {
    source,
    score,
    verdict,
    targetArchetypes: topArchetypes.length > 0 ? topArchetypes : [archetypes[0]?.label ?? "General AI role"],
    summary: `${source} scores ${score.toFixed(1)}/5 against the current North Star. ${verdict === "pursue" ? "It strengthens the target narrative." : verdict === "defer" ? "It is adjacent, but not urgent." : "It does not meaningfully improve the current positioning."}`,
    strengths: unique(skillHits.concat(topArchetypes)).slice(0, 4),
    gaps: [
      verdict === "pursue" ? "Translate the learning into a public proof point quickly." : "Opportunity cost is the main concern.",
      topArchetypes.length === 0 ? "Archetype overlap is weak from the title/description alone." : "Need clearer output artifacts that map to interviews."
    ],
    generatedAt: new Date().toISOString()
  };
}

