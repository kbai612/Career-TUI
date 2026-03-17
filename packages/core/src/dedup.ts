import crypto from "node:crypto";
import type { ApplicationState, JobListing, NormalizedJob } from "./types";

function normalizeText(value: string | undefined): string {
  return (value ?? "")
    .trim()
    .toLowerCase()
    .replace(/https?:\/\//g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function buildFingerprint(listing: Pick<JobListing, "applyUrl" | "company" | "title" | "location" | "externalId">): string {
  const payload = [
    normalizeText(listing.applyUrl),
    normalizeText(listing.company),
    normalizeText(listing.title),
    normalizeText(listing.location),
    normalizeText(listing.externalId)
  ].join("|");
  return crypto.createHash("sha256").update(payload).digest("hex");
}

export function normalizeListing(listing: JobListing, status: ApplicationState = "normalized", visitedCount = 0): NormalizedJob {
  return {
    ...listing,
    fingerprint: buildFingerprint(listing),
    normalizedTitle: normalizeText(listing.title),
    normalizedCompany: normalizeText(listing.company),
    normalizedLocation: normalizeText(listing.location),
    visitedCount,
    status
  };
}

export function incrementVisitCount(current: number): number {
  const next = current + 1;
  if (next > 2) {
    throw new Error("Visited twice max invariant violated");
  }
  return next;
}
