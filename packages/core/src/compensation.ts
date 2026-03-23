const COMPENSATION_CURRENCY_PREFIX_VALUE_PATTERN = /(?:[$\u00A3\u20AC\u00A5\u20B9]\s*|\b(?:usd|cad|eur|gbp)\b\s*)([0-9]{1,3}(?:,[0-9]{3})+(?:\.[0-9]+)?|[0-9]+(?:\.[0-9]+)?)([KM])?/gi;
const COMPENSATION_CURRENCY_SUFFIX_VALUE_PATTERN = /\b([0-9]{1,3}(?:,[0-9]{3})+(?:\.[0-9]+)?|[0-9]+(?:\.[0-9]+)?)([KM])?\s*(?:usd|cad|eur|gbp)\b/gi;
const COMPENSATION_SHORTHAND_VALUE_PATTERN = /\b([0-9]+(?:\.[0-9]+)?)\s*([KM])\b/gi;
const COMPENSATION_RANGE_VALUE_PATTERN = /(?:[$\u00A3\u20AC\u00A5\u20B9]\s*|\b(?:usd|cad|eur|gbp)\b\s*)?([0-9]{1,3}(?:,[0-9]{3})+(?:\.[0-9]+)?|[0-9]+(?:\.[0-9]+)?)([KM])?\s*(?:-|\u2013|to)\s*(?:[$\u00A3\u20AC\u00A5\u20B9]\s*|\b(?:usd|cad|eur|gbp)\b\s*)?([0-9]{1,3}(?:,[0-9]{3})+(?:\.[0-9]+)?|[0-9]+(?:\.[0-9]+)?)([KM])?/gi;
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

function isRangeSalaryToken(raw: string, suffix?: string): boolean {
  if ((suffix ?? "").trim().length > 0) {
    return true;
  }
  const digitsOnly = raw.replace(/[^0-9]/g, "");
  return digitsOnly.length >= 5;
}

function extractCompensationValues(compensationText: string): number[] {
  const values: Array<{ index: number; value: number }> = [];
  COMPENSATION_RANGE_VALUE_PATTERN.lastIndex = 0;
  let rangeMatch: RegExpExecArray | null;
  while ((rangeMatch = COMPENSATION_RANGE_VALUE_PATTERN.exec(compensationText)) != null) {
    if (!isRangeSalaryToken(rangeMatch[1], rangeMatch[2]) || !isRangeSalaryToken(rangeMatch[3], rangeMatch[4])) {
      continue;
    }
    const minValue = normalizeCompensationValue(rangeMatch[1], rangeMatch[2]);
    const maxValue = normalizeCompensationValue(rangeMatch[3], rangeMatch[4]);
    if (minValue > 0 && maxValue > 0) {
      values.push({ index: rangeMatch.index, value: minValue });
      values.push({ index: rangeMatch.index + 1, value: maxValue });
    }
  }

  const collectValues = (pattern: RegExp) => {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(compensationText)) != null) {
      const numericValue = normalizeCompensationValue(match[1], match[2]);
      if (numericValue > 0) {
        values.push({ index: match.index, value: numericValue });
      }
    }
  };
  collectValues(COMPENSATION_CURRENCY_PREFIX_VALUE_PATTERN);
  collectValues(COMPENSATION_CURRENCY_SUFFIX_VALUE_PATTERN);
  collectValues(COMPENSATION_SHORTHAND_VALUE_PATTERN);
  values.sort((a, b) => a.index - b.index);
  const orderedUnique: number[] = [];
  for (const value of values) {
    if (orderedUnique.at(-1) !== value.value) {
      orderedUnique.push(value.value);
    }
  }
  return orderedUnique;
}

export function parseCompensation(text: string | undefined): { salaryMin?: number; salaryMax?: number; compensationText?: string } {
  const compensationText = sanitizeCompensationText(text);
  if (!compensationText) {
    return {};
  }
  const numbers = extractCompensationValues(compensationText);

  return {
    salaryMin: numbers[0],
    salaryMax: numbers[1],
    compensationText
  };
}
