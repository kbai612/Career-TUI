const LEVELS_TORONTO_LOCATION_URL = "https://www.levels.fyi/jobs/location/greater-toronto-area";
const LINKEDIN_LAST_24_HOURS_FILTER = "r86400";

export function normalizeLevelsSourceUrl(sourceUrl: string): string {
  try {
    const parsed = new URL(sourceUrl);
    if (!/levels\.fyi$/i.test(parsed.hostname.replace(/^www\./, ""))) {
      return sourceUrl;
    }
    if (!/^\/jobs\/?$/i.test(parsed.pathname) || parsed.searchParams.has("jobId")) {
      return sourceUrl;
    }
    const location = parsed.searchParams.get("location")?.toLowerCase() ?? "";
    if (!location.includes("toronto")) {
      return sourceUrl;
    }
    return LEVELS_TORONTO_LOCATION_URL;
  } catch {
    return sourceUrl;
  }
}

export function normalizeLinkedInSourceUrl(sourceUrl: string): string {
  try {
    const parsed = new URL(sourceUrl);
    if (!/linkedin\.com$/i.test(parsed.hostname.replace(/^www\./, ""))) {
      return sourceUrl;
    }
    if (!/^\/jobs(\/search)?\/?$/i.test(parsed.pathname)) {
      return sourceUrl;
    }
    parsed.searchParams.set("f_TPR", LINKEDIN_LAST_24_HOURS_FILTER);
    return parsed.toString();
  } catch {
    return sourceUrl;
  }
}
