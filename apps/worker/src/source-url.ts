const LEVELS_TORONTO_LOCATION_URL = "https://www.levels.fyi/jobs/location/greater-toronto-area";

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
