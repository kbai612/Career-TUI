import type { CareerSource, JobListing, RegionRule } from "./types";

const TRACKING_PARAMS = new Set([
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "trk",
  "trkInfo",
  "refId",
  "ref",
  "src",
  "gh_src",
  "gh_jid",
  "li_fat_id",
  "trackingId"
]);

export function canonicalizeUrl(rawUrl: string): string {
  let target = rawUrl;
  try {
    const parsed = new URL(rawUrl);
    if (/linkedin\.com$/i.test(parsed.hostname) && parsed.searchParams.get("url")) {
      target = decodeURIComponent(parsed.searchParams.get("url") ?? rawUrl);
    }
  } catch {
    return rawUrl;
  }

  const url = new URL(target);
  url.hash = "";
  for (const key of Array.from(url.searchParams.keys())) {
    if (TRACKING_PARAMS.has(key) || key.startsWith("utm_")) {
      url.searchParams.delete(key);
    }
  }
  return url.toString();
}

export function resolveCanonicalApplyUrl(listing: JobListing): string {
  const canonical = typeof listing.metadata?.canonicalApplyUrl === "string"
    ? listing.metadata.canonicalApplyUrl
    : typeof listing.metadata?.externalApplyUrl === "string"
      ? listing.metadata.externalApplyUrl
      : listing.applyUrl;
  return canonicalizeUrl(canonical);
}

export function isDiscoverySourceKind(kind: CareerSource["kind"]): boolean {
  return kind === "linkedin" || kind === "levels";
}

export function enrichDiscoveredListing(listing: JobListing, source?: CareerSource): JobListing {
  const canonicalApplyUrl = resolveCanonicalApplyUrl(listing);
  return {
    ...listing,
    applyUrl: canonicalApplyUrl,
    metadata: {
      ...(listing.metadata ?? {}),
      discoverySourceUrl: source?.sourceUrl ?? listing.sourceUrl,
      discoverySourceKind: source?.kind ?? listing.portal,
      discoveryApplyUrl: listing.applyUrl,
      canonicalApplyUrl,
      nonCanonicalDiscovery: source ? isDiscoverySourceKind(source.kind) : false
    }
  };
}

export function matchesRegion(listing: JobListing, region: RegionRule): boolean {
  const haystack = `${listing.location} ${listing.remotePolicy ?? ""}`.toLowerCase();
  const hasAlias = region.aliases.some((alias) => haystack.includes(alias.toLowerCase()));
  const hasRemoteAlias = /remote/i.test(haystack) && region.remoteAliases.some((alias) => haystack.includes(alias.toLowerCase()));
  return hasAlias || hasRemoteAlias;
}

export function filterListingsByRegion(listings: JobListing[], region: RegionRule): JobListing[] {
  return listings.filter((listing) => matchesRegion(listing, region));
}
