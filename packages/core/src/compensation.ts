const COMPENSATION_NUMBER_PATTERN = /\$?([0-9]{1,3}(?:,[0-9]{3})+|[0-9]+(?:\.[0-9]+)?)([KM])?/gi;
const COMPENSATION_SIGNAL_PATTERN = /(?:[$\u00A3\u20AC\u00A5\u20B9])|(?:\b(?:usd|cad|eur|gbp|salary|compensation|bonus|equity|ote|hourly|annual|annually|base)\b)|(?:\bper\s+(?:hour|year|annum)\b)/i;
const SHORTHAND_RANGE_PATTERN = /\b\d+(?:\.\d+)?\s*[KM]\b(?:\s*(?:-|\u2013|to)\s*\$?\d+(?:\.\d+)?\s*[KM]\b)?/i;

function normalizeCompensationValue(raw: string, suffix?: string): number {
  const numeric = Number(raw.replace(/,/g, ""));
  if (!Number.isFinite(numeric)) {
    return 0;
  }
  if (suffix?.toUpperCase() === "M") {
    return Math.round(numeric * 1_000_000);
  }
  if (suffix?.toUpperCase() === "K") {
    return Math.round(numeric * 1_000);
  }
  return Math.round(numeric);
}

export function isCompensationText(text: string | undefined): boolean {
  const normalized = text?.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return false;
  }
  return COMPENSATION_SIGNAL_PATTERN.test(normalized) || SHORTHAND_RANGE_PATTERN.test(normalized);
}

function extractCompensationText(text: string | undefined): string | undefined {
  const normalized = text?.replace(/\s+/g, " ").trim();
  if (!normalized || !isCompensationText(normalized)) {
    return undefined;
  }
  const segments = normalized.split(/\s*[|\u00B7]\s*/).map((segment) => segment.trim()).filter(Boolean);
  const matchedSegment = segments.find((segment) => isCompensationText(segment));
  return matchedSegment ?? normalized;
}

export function sanitizeCompensationText(text: string | undefined): string | undefined {
  return extractCompensationText(text);
}

export function parseCompensation(text: string | undefined): { salaryMin?: number; salaryMax?: number; compensationText?: string } {
  const compensationText = sanitizeCompensationText(text);
  if (!compensationText) {
    return {};
  }
  const numbers = Array.from(compensationText.matchAll(COMPENSATION_NUMBER_PATTERN))
    .map((match) => normalizeCompensationValue(match[1], match[2]))
    .filter((value) => value > 0);

  return {
    salaryMin: numbers[0],
    salaryMax: numbers[1],
    compensationText
  };
}
