import { describe, expect, it } from "vitest";
import { normalizeLevelsSourceUrl } from "../src/source-url";

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
});
