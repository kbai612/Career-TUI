import { describe, expect, it } from "vitest";
import { normalizeLevelsSourceUrl, normalizeLinkedInSourceUrl } from "../src/source-url";

describe("worker", () => {
  it("normalizes legacy Levels Toronto search URLs to the location discovery page", () => {
    const sourceUrl = "https://www.levels.fyi/jobs/?location=Toronto%2C%20Ontario%2C%20Canada&searchText=data";
    expect(normalizeLevelsSourceUrl(sourceUrl)).toBe("https://www.levels.fyi/jobs/location/greater-toronto-area");
  });

  it("keeps non-Toronto Levels URLs unchanged", () => {
    const sourceUrl = "https://www.levels.fyi/jobs/?location=New%20York%2C%20NY%2C%20United%20States&searchText=data";
    expect(normalizeLevelsSourceUrl(sourceUrl)).toBe(sourceUrl);
  });

  it("keeps direct Levels job URLs unchanged", () => {
    const sourceUrl = "https://www.levels.fyi/jobs?jobId=123456";
    expect(normalizeLevelsSourceUrl(sourceUrl)).toBe(sourceUrl);
  });

  it("keeps non-Levels URLs unchanged", () => {
    const sourceUrl = "https://ca.indeed.com/jobs?q=data+analyst&l=Toronto%2C+ON";
    expect(normalizeLevelsSourceUrl(sourceUrl)).toBe(sourceUrl);
  });

  it("enforces LinkedIn searches to last 24 hours", () => {
    const sourceUrl = "https://www.linkedin.com/jobs/search/?keywords=Data%20Analyst&location=Toronto%2C%20Ontario%2C%20Canada";
    const normalized = normalizeLinkedInSourceUrl(sourceUrl);
    expect(new URL(normalized).searchParams.get("f_TPR")).toBe("r86400");
  });

  it("overrides existing LinkedIn recency filters to 24 hours", () => {
    const sourceUrl = "https://www.linkedin.com/jobs/search/?keywords=Data%20Analyst&f_TPR=r604800";
    const normalized = normalizeLinkedInSourceUrl(sourceUrl);
    expect(new URL(normalized).searchParams.get("f_TPR")).toBe("r86400");
  });

  it("keeps non-LinkedIn URLs unchanged for LinkedIn normalization", () => {
    const sourceUrl = "https://ca.indeed.com/jobs?q=data+analyst&l=Toronto%2C+ON";
    expect(normalizeLinkedInSourceUrl(sourceUrl)).toBe(sourceUrl);
  });
});
