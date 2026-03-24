import type { ApplicationDraft, EvaluationReport, JobListing, ProfilePack } from "./types";

const ROLE_PROMPT_KEY_PATTERN = /(?:why|motivation|interest|cover|summary|project|achievement|challenge|additional|message|question|work sample)/i;

function normalizeMemoryAnswers(memoryAnswers: Record<string, string> | undefined): Record<string, string> {
  if (memoryAnswers == null) {
    return {};
  }

  const normalized: Record<string, string> = {};
  for (const [rawKey, rawValue] of Object.entries(memoryAnswers)) {
    const key = rawKey.trim();
    const value = rawValue.trim();
    if (key.length === 0 || value.length === 0) {
      continue;
    }
    normalized[key] = value;
  }
  return normalized;
}

export function buildApplicationDraft(
  jobId: number,
  job: JobListing,
  report: EvaluationReport,
  profile: ProfilePack,
  memoryAnswers?: Record<string, string>
): ApplicationDraft {
  const reusableAnswers = normalizeMemoryAnswers(memoryAnswers);
  const memoryRoleSpecificAnswers = Object.entries(reusableAnswers)
    .filter(([key]) => ROLE_PROMPT_KEY_PATTERN.test(key))
    .slice(0, 3)
    .map(([key, value]) => `${key}: ${value}`);

  return {
    jobId,
    targetUrl: job.applyUrl,
    answers: {
      full_name: profile.name,
      email: profile.email,
      phone: profile.phone,
      location: profile.location,
      linkedin: profile.linkedin ?? "",
      github: profile.github ?? "",
      portfolio: profile.portfolio ?? "",
      requires_sponsorship: profile.eeo.requiresSponsorship ?? "No",
      race: profile.eeo.race ?? "Prefer not to say",
      gender: profile.eeo.gender ?? "Prefer not to say",
      veteran: profile.eeo.veteran ?? "No",
      disability: profile.eeo.disability ?? "No",
      ...reusableAnswers
    },
    roleSpecificAnswers: [
      `I am a strong fit for ${job.title} because ${report.executiveSummary}`,
      `My strongest proof point is ${report.cvMatches[0]?.proofPoint ?? profile.proofPoints[0]}.`,
      `I am especially interested in ${job.company} because the role aligns with ${report.archetypeLabel} and scores ${report.totalScore.toFixed(1)}/5 (${report.grade}).`,
      `The first risk I would address proactively is ${report.riskSignals[0] ?? "scope clarification during the interview process"}.`,
      ...memoryRoleSpecificAnswers
    ],
    reviewRequired: true,
    status: "drafted",
    generatedAt: new Date().toISOString()
  };
}

export function ensureReviewRequired(draft: ApplicationDraft): void {
  if (!draft.reviewRequired) {
    throw new Error("Application draft must require manual review.");
  }
}

