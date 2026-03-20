import type { ApplicationDraft, EvaluationReport, JobListing, ProfilePack } from "./types";

export function buildApplicationDraft(jobId: number, job: JobListing, report: EvaluationReport, profile: ProfilePack): ApplicationDraft {
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
      disability: profile.eeo.disability ?? "No"
    },
    roleSpecificAnswers: [
      `I am a strong fit for ${job.title} because ${report.executiveSummary}`,
      `My strongest proof point is ${report.cvMatches[0]?.proofPoint ?? profile.proofPoints[0]}.`,
      `I am especially interested in ${job.company} because the role aligns with ${report.archetypeLabel} and scores ${report.totalScore.toFixed(1)}/5 (${report.grade}).`,
      `The first risk I would address proactively is ${report.riskSignals[0] ?? "scope clarification during the interview process"}.`
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

