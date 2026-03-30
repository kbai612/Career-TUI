export interface NameParts {
  firstName: string;
  lastName: string;
}

export type AutoApplyMode = "pyautogui" | "playwright";
export type LinkedInEntryKind = "easy_apply" | "apply";

export interface LinkedInEntryCandidateSample {
  text: string;
  ariaLabel: string;
  href: string;
  className: string;
  id: string;
  dataTrackingControlName: string;
  top: number;
  left: number;
  width: number;
  height: number;
  viewportHeight: number;
  ancestorHints: string[];
}

const SEND_KEYS_SPECIAL_CHARACTERS = /[+^%~()[\]{}]/g;
const AUTOFILL_TRAP_PATTERN = /robots only|do not enter if you'?re human|do not enter if you are human|honeypot|leave (?:this )?field blank|spam trap|human users should leave/i;

export function splitName(fullName: string): NameParts {
  const cleaned = fullName.trim().replace(/\s+/g, " ");
  if (cleaned.length === 0) {
    return {
      firstName: "Career",
      lastName: "Ops"
    };
  }
  const parts = cleaned.split(" ");
  if (parts.length === 1) {
    return {
      firstName: parts[0],
      lastName: "Candidate"
    };
  }
  return {
    firstName: parts[0],
    lastName: parts.slice(1).join(" ")
  };
}

export function escapeSendKeysLiteral(value: string): string {
  return value.replace(SEND_KEYS_SPECIAL_CHARACTERS, (character) => `{${character}}`);
}

export function normalizeAutoApplyMode(value: string | undefined): AutoApplyMode {
  const normalized = (value ?? "").trim().toLowerCase();
  if (normalized.length === 0 || normalized === "os" || normalized === "pyautogui") {
    return "pyautogui";
  }
  if (normalized === "playwright") {
    return "playwright";
  }
  throw new Error(`Unsupported autoapply mode "${value}". Expected "pyautogui" or "playwright".`);
}

export function isAutofillTrapText(value: string): boolean {
  const normalized = value.replace(/\s+/g, " ").trim().toLowerCase();
  return normalized.length > 0 && AUTOFILL_TRAP_PATTERN.test(normalized);
}

export function isLinkedInJobPostingUrl(value: string | undefined): boolean {
  if ((value ?? "").trim().length === 0) {
    return false;
  }
  try {
    const parsed = new URL(value as string);
    return /(^|\.)linkedin\.com$/i.test(parsed.hostname) && /^\/jobs\/(?:view|collections)\//i.test(parsed.pathname);
  } catch {
    return /linkedin\.com\/jobs\/(?:view|collections)\//i.test(String(value));
  }
}

export function resolveLinkedInJobPostingUrl(
  applyUrl: string,
  metadata?: Record<string, unknown>,
  sourceUrl?: string
): string | null {
  const candidates = [
    typeof metadata?.discoveryApplyUrl === "string" ? metadata.discoveryApplyUrl : "",
    typeof metadata?.jobViewUrl === "string" ? metadata.jobViewUrl : "",
    applyUrl,
    sourceUrl ?? ""
  ];
  for (const candidate of candidates) {
    if (isLinkedInJobPostingUrl(candidate)) {
      return candidate;
    }
  }
  return null;
}

function normalizeCandidateText(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function buildCandidateSummary(sample: LinkedInEntryCandidateSample): string {
  return normalizeCandidateText([
    sample.text,
    sample.ariaLabel,
    sample.href,
    sample.className,
    sample.id,
    sample.dataTrackingControlName,
    ...sample.ancestorHints
  ].join(" "));
}

export function classifyLinkedInEntryCandidate(sample: LinkedInEntryCandidateSample): LinkedInEntryKind | null {
  const text = normalizeCandidateText(sample.text);
  const ariaLabel = normalizeCandidateText(sample.ariaLabel);
  const href = normalizeCandidateText(sample.href);
  const tracking = normalizeCandidateText(sample.dataTrackingControlName);
  const summary = buildCandidateSummary(sample);

  if (
    href.includes("linkedin.com/safety/go/")
    || /apply on company (website|site)/i.test(summary)
  ) {
    return "apply";
  }

  if (
    href.includes("opensduiapplyflow=true")
    || /easy apply/i.test(`${text} ${ariaLabel}`)
    || tracking.includes("apply-link-onsite")
  ) {
    return "easy_apply";
  }

  if (
    /^(apply|apply now)$/.test(text)
    || /^(apply|apply now)$/.test(ariaLabel)
  ) {
    return "apply";
  }

  return null;
}

export function scoreLinkedInEntryCandidate(
  sample: LinkedInEntryCandidateSample,
  kind: LinkedInEntryKind | null = classifyLinkedInEntryCandidate(sample)
): number {
  if (kind == null) {
    return Number.NEGATIVE_INFINITY;
  }

  const text = normalizeCandidateText(sample.text);
  const href = normalizeCandidateText(sample.href);
  const summary = buildCandidateSummary(sample);
  const viewportHeight = Math.max(1, Number(sample.viewportHeight) || 1);
  const isTopCard = /top-card|jobs-unified-top-card|sub-nav-cta|topbar-apply/i.test(summary);
  const isSidebarCard = /jobs\/collections\/similar-jobs|similar-jobs|job-card-container|people-also-viewed|browse-jobs/i.test(summary);
  const looksLikeJobCard = sample.height >= 120 || sample.width >= 220 || /posted on .* easy apply/i.test(text);

  let score = kind === "apply" ? 220 : 210;

  if (kind === "apply") {
    if (href.includes("linkedin.com/safety/go/")) {
      score += 260;
    }
    if (/apply on company (website|site)/i.test(summary)) {
      score += 180;
    }
    if (/^(apply|apply now)$/.test(text)) {
      score += 40;
    }
  } else {
    if (/easy apply/i.test(summary)) {
      score += 260;
    }
    if (href.includes("opensduiapplyflow=true")) {
      score += 220;
    }
    if (/apply-link-onsite/i.test(summary)) {
      score += 120;
    }
  }

  if (isTopCard) {
    score += 180;
  }
  if (sample.top <= Math.max(420, viewportHeight * 0.55)) {
    score += 160;
  } else if (sample.top <= viewportHeight) {
    score += 90;
  } else {
    score -= 120;
  }
  if (sample.top < -60) {
    score -= 60;
  }
  if (isSidebarCard) {
    score -= 320;
  }
  if (looksLikeJobCard) {
    score -= 180;
  }

  return score;
}

export function pickBestLinkedInEntryCandidate<T extends LinkedInEntryCandidateSample>(
  samples: T[],
  preferredKind?: LinkedInEntryKind
): (T & { kind: LinkedInEntryKind; score: number }) | null {
  const scored = samples
    .map((sample) => {
      const kind = classifyLinkedInEntryCandidate(sample);
      const score = scoreLinkedInEntryCandidate(sample, kind);
      return kind == null
        ? null
        : {
            ...sample,
            kind,
            score
          };
    })
    .filter((sample): sample is T & { kind: LinkedInEntryKind; score: number } => sample != null)
    .sort((left, right) => right.score - left.score);

  if (preferredKind == null) {
    return scored[0] ?? null;
  }
  return scored.find((sample) => sample.kind === preferredKind) ?? null;
}

function stripHtml(value: string): string {
  return value
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#39;/gi, "'")
    .replace(/&quot;/gi, "\"")
    .replace(/\s+/g, " ")
    .trim();
}

function decodeQuotedPrintable(value: string): string {
  return value
    .replace(/=\r?\n/g, "")
    .replace(/=([A-Fa-f0-9]{2})/g, (_match, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
}

function extractFromKeywordPatterns(text: string): string | null {
  const patterns = [
    /(?:verification|security|one[\s-]?time|login|sign[\s-]?in|otp|passcode|code)\D{0,36}(\d{4,8})/i,
    /(\d{4,8})\D{0,36}(?:verification|security|one[\s-]?time|login|sign[\s-]?in|otp|passcode|code)/i
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (match?.[1] != null) {
      return match[1];
    }
  }
  return null;
}

function extractFromNumericTokens(text: string): string | null {
  const tokenMatches = text.match(/\b\d{4,8}\b/g) ?? [];
  if (tokenMatches.length === 0) {
    return null;
  }

  const preferred = tokenMatches.find((token) => token.length === 6)
    ?? tokenMatches.find((token) => token.length === 5 || token.length === 7)
    ?? tokenMatches[0];
  return preferred ?? null;
}

export function extractOtpCodeFromText(input: string): string | null {
  const normalized = stripHtml(input);
  if (normalized.length === 0) {
    return null;
  }

  const keywordMatch = extractFromKeywordPatterns(normalized);
  if (keywordMatch != null) {
    return keywordMatch;
  }

  return extractFromNumericTokens(normalized);
}

export function extractVerificationUrlFromText(input: string): string | null {
  const decoded = decodeQuotedPrintable(input);
  const candidates = decoded.match(/https?:\/\/[^\s"'<>]+/gi) ?? [];
  for (const candidate of candidates) {
    const normalized = candidate
      .replace(/&amp;/gi, "&")
      .replace(/[),.;]+$/g, "");
    if (!/activate|verify|verification|confirm/i.test(normalized)) {
      continue;
    }
    try {
      return new URL(normalized).toString();
    } catch {
      continue;
    }
  }
  return null;
}
