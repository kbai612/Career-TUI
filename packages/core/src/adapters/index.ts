import { load } from "cheerio";
import { parseCompensation } from "../compensation";
import { canonicalizeUrl } from "../discovery";
import type { JobListing, PortalAdapter, SourceKind } from "../types";

function absoluteUrl(base: string, href: string | undefined): string {
  if (!href) {
    return canonicalizeUrl(base);
  }
  return canonicalizeUrl(new URL(href, base).toString());
}

function hostnameCompany(sourceUrl: string): string {
  return new URL(sourceUrl).hostname.replace(/^www\./, "");
}

function boardCompany(sourceUrl: string): string {
  try {
    const url = new URL(sourceUrl);
    const boardParam = url.searchParams.get("for");
    if (boardParam) {
      return boardParam;
    }
    const segments = url.pathname.split("/").filter(Boolean);
    if (url.hostname.includes("lever.co") && segments[0]) {
      return segments[0];
    }
    return hostnameCompany(sourceUrl);
  } catch {
    return hostnameCompany(sourceUrl);
  }
}

function htmlString($: ReturnType<typeof load>): string {
  return $.root().html() ?? "";
}

function normalizeText(value: string | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

function parseJsonSafely<T>(value: string): T | null {
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

function stripHtml(value: string | undefined): string {
  return normalizeText((value ?? "").replace(/<[^>]+>/g, " "));
}

function normalizePostedAt(value: unknown): string | undefined {
  if (value == null) {
    return undefined;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    const normalized = value > 1_000_000_000_000 ? value : value * 1000;
    const date = new Date(normalized);
    return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
  }
  if (typeof value === "string") {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
  }
  return undefined;
}

function parseRelativePostedAt(value: string): string | undefined {
  const normalized = normalizeText(value).toLowerCase();
  if (!normalized) {
    return undefined;
  }
  if (normalized.includes("just now") || normalized === "today") {
    return new Date().toISOString();
  }
  if (normalized.includes("yesterday")) {
    return new Date(Date.now() - (24 * 60 * 60 * 1000)).toISOString();
  }

  const relativeMatch = normalized.match(/(\d+)\s*\+?\s*(minute|hour|day|week|month|year)s?\s+ago/);
  if (relativeMatch == null) {
    return undefined;
  }

  const amount = Number.parseInt(relativeMatch[1], 10);
  if (!Number.isFinite(amount) || amount <= 0) {
    return undefined;
  }

  const unit = relativeMatch[2];
  const unitMs = (() => {
    switch (unit) {
      case "minute":
        return 60 * 1000;
      case "hour":
        return 60 * 60 * 1000;
      case "day":
        return 24 * 60 * 60 * 1000;
      case "week":
        return 7 * 24 * 60 * 60 * 1000;
      case "month":
        return 30 * 24 * 60 * 60 * 1000;
      case "year":
        return 365 * 24 * 60 * 60 * 1000;
      default:
        return 0;
    }
  })();
  if (unitMs <= 0) {
    return undefined;
  }

  return new Date(Date.now() - (amount * unitMs)).toISOString();
}

function parseLinkedInPostedAt(card: { find: (selector: string) => any }, metaText: string | undefined): string | undefined {
  const datetimeRaw = normalizeText(card.find("time[datetime]").first().attr("datetime"));
  const parsedDatetime = normalizePostedAt(datetimeRaw);
  const relativeFromTime = parseRelativePostedAt(card.find("time").first().text());
  if (datetimeRaw.length > 0 && !datetimeRaw.includes("T") && relativeFromTime != null) {
    return relativeFromTime;
  }
  if (parsedDatetime != null) {
    return parsedDatetime;
  }
  if (relativeFromTime != null) {
    return relativeFromTime;
  }
  if (metaText == null) {
    return undefined;
  }
  return parseRelativePostedAt(metaText);
}

function isLinkedInUrl(value: string): boolean {
  try {
    return /(^|\.)linkedin\.com$/i.test(new URL(value).hostname);
  } catch {
    return /linkedin\.com/i.test(value);
  }
}

function extractListing($card: ReturnType<typeof load>, sourceUrl: string, portal: string, selectors: {
  title: string;
  link: string;
  company?: string;
  location?: string;
  meta?: string;
}): JobListing[] {
  const jobs: JobListing[] = [];
  $card(selectors.link).each((_, element) => {
    const anchor = $card(element);
    const card = anchor.closest("div, li, tr, article");
    const title = card.find(selectors.title).first().text().trim() || anchor.text().trim();
    if (!title) {
      return;
    }
    const metaText = selectors.meta ? card.find(selectors.meta).text().trim() : undefined;
    jobs.push({
      portal,
      sourceUrl,
      applyUrl: absoluteUrl(sourceUrl, anchor.attr("href")),
      company: selectors.company ? card.find(selectors.company).first().text().trim() || hostnameCompany(sourceUrl) : hostnameCompany(sourceUrl),
      title,
      location: selectors.location ? card.find(selectors.location).first().text().trim() || "Unknown" : "Unknown",
      description: metaText,
      metadata: metaText ? parseCompensation(metaText) : undefined,
      ...parseCompensation(metaText)
    });
  });
  return jobs;
}

export function extractDirectListing(html: string, sourceUrl: string, portal = "generic"): JobListing | null {
  const $ = load(html);
  const bodyText = $("body").text().replace(/\s+/g, " ").trim();
  const title = $("meta[property='og:title']").attr("content")?.trim()
    || $("meta[name='twitter:title']").attr("content")?.trim()
    || $("h1").first().text().trim()
    || $("title").text().trim();

  if (!title || title.length < 8) {
    return null;
  }

  const host = hostnameCompany(sourceUrl);
  const company = title.includes(" at ") ? title.split(" at ").pop()?.trim() || host : host;
  const location = $("[data-automation-id='locations'], .location, [class*='location']").first().text().trim()
    || (/remote/i.test(bodyText) ? "Remote" : "Unknown");
  const description = $("meta[name='description']").attr("content")?.trim()
    || $("article").text().replace(/\s+/g, " ").trim()
    || bodyText.slice(0, 1200);
  const compensationSource = $("body").text().match(/\$[0-9,]+(?:\s*-\s*\$[0-9,]+)?/)?.[0] ?? undefined;

  return {
    portal,
    sourceUrl,
    applyUrl: canonicalizeUrl(sourceUrl),
    company,
    title,
    location,
    description,
    rawHtml: html,
    ...parseCompensation(compensationSource)
  };
}

function parseLinkedInDirectListing($: ReturnType<typeof load>, sourceUrl: string): JobListing | null {
  const title = $("h1").first().text().trim() || $("title").text().trim();
  if (!title) {
    return null;
  }
  const company = $(".topcard__org-name-link, .topcard__flavor-row a, .job-details-jobs-unified-top-card__company-name").first().text().trim()
    || hostnameCompany(sourceUrl);
  const location = $(".topcard__flavor--bullet, .job-details-jobs-unified-top-card__bullet").first().text().trim() || "Unknown";
  const externalApplyUrl = $("a[href*='externalApply'], a[href*='offsite'], a[data-tracking-control-name*='apply'], a.topcard__apply-link").first().attr("href");
  const description = $(".show-more-less-html__markup, .description__text, article").first().text().replace(/\s+/g, " ").trim();

  return {
    portal: "linkedin",
    sourceUrl,
    applyUrl: canonicalizeUrl(externalApplyUrl ? absoluteUrl(sourceUrl, externalApplyUrl) : sourceUrl),
    company,
    title,
    location,
    description,
    rawHtml: htmlString($),
    metadata: {
      nonCanonicalDiscovery: true,
      ...(externalApplyUrl ? { canonicalApplyUrl: absoluteUrl(sourceUrl, externalApplyUrl) } : {})
    }
  };
}

function parseLevelsDirectListing($: ReturnType<typeof load>, sourceUrl: string): JobListing | null {
  const title = $("h1").first().text().trim() || $("title").text().trim();
  if (!title) {
    return null;
  }
  const company = $("a[href*='/company/'], [class*='company']").first().text().trim() || hostnameCompany(sourceUrl);
  const location = $("[class*='location'], [data-testid='job-location']").first().text().trim() || "Unknown";
  const externalApplyUrl = $("a[href*='apply'], a[href*='greenhouse'], a[href*='lever'], a[href*='ashby'], a[href*='workday']").first().attr("href");
  const description = $("main, article").first().text().replace(/\s+/g, " ").trim();
  const compText = $("body").text().match(/\$[0-9,]+(?:\s*-\s*\$[0-9,]+)?/)?.[0] ?? undefined;

  return {
    portal: "levels",
    sourceUrl,
    applyUrl: canonicalizeUrl(externalApplyUrl ? absoluteUrl(sourceUrl, externalApplyUrl) : sourceUrl),
    company,
    title,
    location,
    description,
    compensationText: compText,
    rawHtml: htmlString($),
    metadata: {
      nonCanonicalDiscovery: true,
      ...(externalApplyUrl ? { canonicalApplyUrl: absoluteUrl(sourceUrl, externalApplyUrl) } : {})
    },
    ...parseCompensation(compText)
  };
}

function parseLevelsNextData(html: string, sourceUrl: string): JobListing[] {
  const nextDataMatch = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/i);
  if (nextDataMatch == null) {
    return [];
  }

  try {
    const nextData = JSON.parse(nextDataMatch[1]) as {
      props?: {
        pageProps?: {
          initialJobsData?: {
            results?: Array<{
              companyName?: string;
              shortDescription?: string;
              jobs?: Array<{
                id?: string | number;
                title?: string;
                locations?: string[];
                applicationUrl?: string;
                postingDate?: string;
                minBaseSalary?: number;
                maxBaseSalary?: number;
                baseSalaryCurrency?: string;
              }>;
            }>;
          };
        };
      };
    };

    const results = nextData.props?.pageProps?.initialJobsData?.results ?? [];
    return results.flatMap((companyResult) => {
      const company = companyResult.companyName?.trim() || hostnameCompany(sourceUrl);
      const description = companyResult.shortDescription?.trim();
      return (companyResult.jobs ?? [])
        .filter((job) => typeof job.title === "string" && typeof job.applicationUrl === "string")
        .map((job) => {
          const minSalary = job.minBaseSalary;
          const maxSalary = job.maxBaseSalary;
          const currency = job.baseSalaryCurrency;
          const compensationText = minSalary != null && maxSalary != null && currency
            ? `${currency} ${minSalary.toLocaleString()} - ${maxSalary.toLocaleString()}`
            : undefined;

          return {
            portal: "levels",
            sourceUrl,
            applyUrl: canonicalizeUrl(job.applicationUrl as string),
            company,
            title: (job.title as string).trim(),
            location: Array.isArray(job.locations) && job.locations.length > 0 ? job.locations.join(" | ") : "Unknown",
            postedAt: job.postingDate,
            compensationText,
            salaryMin: minSalary,
            salaryMax: maxSalary,
            description,
            metadata: {
              nonCanonicalDiscovery: true,
              canonicalApplyUrl: canonicalizeUrl(job.applicationUrl as string),
              levelsJobId: job.id
            }
          } satisfies JobListing;
        });
    });
  } catch {
    return [];
  }
}

function parseLevelsLocationPage(html: string, sourceUrl: string): JobListing[] {
  const $ = load(html);
  const jobs: JobListing[] = [];

  $("div[role='button']").each((_, element) => {
    const card = $(element);
    const company = card.find("[class*='companyName']").first().text().trim();
    if (!company) {
      return;
    }

    const description = card.find("[class*='shortDescription']").first().text().trim() || undefined;
    card.find("a[href*='/jobs?jobId=']").each((__, linkElement) => {
      const link = $(linkElement);
      const title = link.find("[class*='companyJobTitle']").first().clone().children().remove().end().text().trim();
      const locationText = link.find("[class*='companyJobLocation']").first().text().replace(/\s+/g, " ").trim();
      const relativeHref = link.attr("href");
      if (!title || !relativeHref) {
        return;
      }

      jobs.push({
        portal: "levels",
        sourceUrl,
        applyUrl: absoluteUrl(sourceUrl, relativeHref),
        company,
        title,
        location: locationText.split("·")[0]?.trim() || "Unknown",
        compensationText: locationText.includes("$") ? locationText.split("·").map((part) => part.trim()).find((part) => part.includes("$")) : undefined,
        description,
        metadata: {
          nonCanonicalDiscovery: true
        },
        ...parseCompensation(locationText)
      });
    });
  });

  return jobs;
}

function parseWorkopolisSearchListings(html: string, sourceUrl: string): JobListing[] {
  const $ = load(html);
  const jobs: JobListing[] = [];

  $("[data-testid='searchSerpJob']").each((_, element) => {
    const card = $(element);
    const link = card.find("a[href*='/jobsearch/viewjob/']").first();
    const title = normalizeText(card.find("[data-testid='searchSerpJobTitle']").first().text() || link.text());
    const href = link.attr("href");
    if (!title || !href) {
      return;
    }

    const company = normalizeText(card.find("[data-testid='companyName'], [data-testid*='company']").first().text()) || hostnameCompany(sourceUrl);
    const location = normalizeText(card.find("[data-testid='searchSerpJobLocation'], [data-testid*='location']").first().text()) || "Unknown";
    const salaryText = normalizeText(card.find("[data-testid^='salaryChip']").first().text()) || undefined;
    const allChipsText = normalizeText(card.find("[data-testid='variant2-allChips']").first().text()) || undefined;
    const description = normalizeText(card.find("p").first().text()) || undefined;
    const compensationSource = salaryText ?? allChipsText ?? description;

    jobs.push({
      portal: "generic",
      sourceUrl,
      applyUrl: absoluteUrl(sourceUrl, href),
      company,
      title,
      location,
      description,
      metadata: compensationSource ? parseCompensation(compensationSource) : undefined,
      ...parseCompensation(compensationSource)
    });
  });

  return jobs;
}

interface GreenhouseApiResponse {
  jobs?: Array<{
    id?: number | string;
    title?: string;
    absolute_url?: string;
    updated_at?: string;
    created_at?: string;
    content?: string;
    location?: {
      name?: string;
    };
  }>;
}

function parseGreenhouseApiListings(raw: string, sourceUrl: string): JobListing[] {
  const parsed = parseJsonSafely<GreenhouseApiResponse>(raw);
  const jobs = parsed?.jobs;
  if (!Array.isArray(jobs)) {
    return [];
  }
  const listings: JobListing[] = [];
  for (const job of jobs) {
    const title = normalizeText(job.title);
    const applyUrl = typeof job.absolute_url === "string" ? canonicalizeUrl(job.absolute_url) : "";
    if (!title || !applyUrl) {
      continue;
    }
    const location = normalizeText(job.location?.name) || "Unknown";
    const description = stripHtml(job.content);
    const postedAt = normalizePostedAt(job.updated_at ?? job.created_at);
    const compensationSource = description || undefined;

    listings.push({
      portal: "greenhouse",
      sourceUrl,
      applyUrl,
      company: boardCompany(sourceUrl),
      title,
      location,
      postedAt,
      description: description || undefined,
      externalId: job.id == null ? undefined : String(job.id),
      metadata: {
        apiSource: "greenhouse",
        greenhouseJobId: job.id
      },
      ...parseCompensation(compensationSource)
    });
  }
  return listings;
}

interface LeverApiPosting {
  id?: string;
  text?: string;
  hostedUrl?: string;
  createdAt?: number | string;
  description?: string;
  descriptionPlain?: string;
  categories?: {
    location?: string;
    commitment?: string;
  };
}

function parseLeverApiListings(raw: string, sourceUrl: string): JobListing[] {
  const parsed = parseJsonSafely<LeverApiPosting[]>(raw);
  if (!Array.isArray(parsed)) {
    return [];
  }
  const listings: JobListing[] = [];
  for (const job of parsed) {
    const title = normalizeText(job.text);
    const applyUrl = typeof job.hostedUrl === "string" ? canonicalizeUrl(job.hostedUrl) : "";
    if (!title || !applyUrl) {
      continue;
    }
    const location = normalizeText(job.categories?.location) || "Unknown";
    const employmentType = normalizeText(job.categories?.commitment) || undefined;
    const description = normalizeText(job.descriptionPlain ?? stripHtml(job.description));
    const postedAt = normalizePostedAt(job.createdAt);
    const compensationSource = [description, location, employmentType].filter((part) => part != null && part.length > 0).join(" ");

    listings.push({
      portal: "lever",
      sourceUrl,
      applyUrl,
      company: boardCompany(sourceUrl),
      title,
      location,
      postedAt,
      employmentType,
      description: description || undefined,
      externalId: job.id,
      metadata: {
        apiSource: "lever",
        leverJobId: job.id
      },
      ...parseCompensation(compensationSource || undefined)
    });
  }
  return listings;
}

export const greenhouseAdapter: PortalAdapter = {
  portal: "greenhouse",
  matches: (sourceUrl) => /greenhouse\.io/i.test(sourceUrl),
  discoverListings(html, sourceUrl) {
    const apiListings = parseGreenhouseApiListings(html, sourceUrl);
    if (apiListings.length > 0) {
      return apiListings;
    }
    const $ = load(html);
    const rowListings: JobListing[] = [];
    $("tr.job-post, div.opening, li.opening").each((_, element) => {
      const row = $(element);
      const link = row.find("a[href]").first();
      const paragraphs = link.find("p");
      const title = normalizeText(
        paragraphs.first().text()
        || link.find(".opening, .opening-title, [data-mapped='true']").first().text()
        || link.text()
      );
      const location = normalizeText(
        paragraphs.eq(1).text()
        || row.find("p.body.body__secondary.body--metadata, .location, .opening-location").first().text()
        || link.find("p.body.body__secondary.body--metadata, .location, .opening-location").first().text()
      );
      const href = link.attr("href");
      if (!title || !href) {
        return;
      }
      rowListings.push({
        portal: "greenhouse",
        sourceUrl,
        applyUrl: absoluteUrl(sourceUrl, href),
        company: boardCompany(sourceUrl),
        title,
        location: location || "Unknown",
        description: location || undefined
      });
    });
    if (rowListings.length > 0) {
      return rowListings;
    }
    return extractListing($, sourceUrl, "greenhouse", {
      title: ".opening, .opening-title, p.body.body--medium",
      link: "a[href*='/jobs/'], a.opening",
      location: ".location, .opening-location, p.body__secondary.body--metadata",
      meta: ".location, .opening-location, p.body__secondary.body--metadata"
    });
  }
};

export const leverAdapter: PortalAdapter = {
  portal: "lever",
  matches: (sourceUrl) => /lever\.co/i.test(sourceUrl),
  discoverListings(html, sourceUrl) {
    const apiListings = parseLeverApiListings(html, sourceUrl);
    if (apiListings.length > 0) {
      return apiListings;
    }
    const $ = load(html);
    const listings: JobListing[] = [];
    $("div.posting").each((_, element) => {
      const posting = $(element);
      const link = posting.find("a.posting-title").first();
      const title = normalizeText(link.find("h5[data-qa='posting-name'], h5").first().text() || link.text());
      const location = normalizeText(posting.find(".posting-categories .sort-by-location, .location").first().text());
      const meta = normalizeText(posting.find(".posting-categories").first().text());
      const href = link.attr("href");
      if (!title || !href || /^apply$/i.test(title)) {
        return;
      }
      listings.push({
        portal: "lever",
        sourceUrl,
        applyUrl: absoluteUrl(sourceUrl, href),
        company: boardCompany(sourceUrl),
        title,
        location: location || "Unknown",
        description: meta || undefined,
        metadata: meta ? parseCompensation(meta) : undefined,
        ...parseCompensation(meta)
      });
    });
    if (listings.length > 0) {
      return listings;
    }
    return extractListing($, sourceUrl, "lever", {
      title: ".posting-title h5, .posting-title",
      link: "a.posting-title, a[href*='/jobs'][class*='posting-title']",
      location: ".posting-categories .sort-by-location, .location",
      meta: ".posting-categories"
    }).filter((listing) => !/^apply$/i.test(listing.title));
  }
};

export const ashbyAdapter: PortalAdapter = {
  portal: "ashby",
  matches: (sourceUrl) => /ashbyhq\.com/i.test(sourceUrl),
  discoverListings(html, sourceUrl) {
    const $ = load(html);
    return extractListing($, sourceUrl, "ashby", {
      title: "[data-testid='job-title'], h3, h4",
      link: "a[href*='/job/'], a[href*='/jobs/']",
      location: "[data-testid='job-location'], .location",
      meta: ".job-posting-category"
    });
  }
};

export const workdayAdapter: PortalAdapter = {
  portal: "workday",
  matches: (sourceUrl) => /workday/i.test(sourceUrl),
  discoverListings(html, sourceUrl) {
    const $ = load(html);
    return extractListing($, sourceUrl, "workday", {
      title: "h3, [data-automation-id='jobPostingHeader']",
      link: "a[href*='/job/']",
      location: "[data-automation-id='locations']",
      meta: "[data-automation-id='locations']"
    });
  }
};

export const linkedinAdapter: PortalAdapter = {
  portal: "linkedin",
  matches: (sourceUrl) => /linkedin\.com\/jobs/i.test(sourceUrl),
  discoverListings(html, sourceUrl) {
    const $ = load(html);
    const jobs: JobListing[] = [];
    const seenApplyUrls = new Set<string>();
    $(".base-search-card, .job-search-card, li.jobs-search-results__list-item, li[class*='jobs-search-results__list-item']").each((_, element) => {
      const card = $(element);
      const anchor = card.find("a.base-card__full-link, a.base-card__link, a[href*='/jobs/view/']").first();
      const href = anchor.attr("href");
      const title = normalizeText(card.find(".base-search-card__title, .job-search-card__title, h3.base-search-card__title, h3").first().text() || anchor.text());
      if (!title || !href) {
        return;
      }
      const applyUrl = absoluteUrl(sourceUrl, href);
      if (seenApplyUrls.has(applyUrl)) {
        return;
      }
      seenApplyUrls.add(applyUrl);
      const metaText = normalizeText(card.find(".base-search-card__metadata, .job-search-card__listdate, time").first().text()) || undefined;
      jobs.push({
        portal: "linkedin",
        sourceUrl,
        applyUrl,
        company: normalizeText(card.find(".base-search-card__subtitle, .job-search-card__subtitle, h4.base-search-card__subtitle").first().text()) || hostnameCompany(sourceUrl),
        title,
        location: normalizeText(card.find(".job-search-card__location, .base-search-card__location").first().text())
          || normalizeText(card.find(".base-search-card__metadata").first().text())
          || "Unknown",
        postedAt: parseLinkedInPostedAt(card, metaText),
        description: metaText,
        metadata: {
          ...parseCompensation(metaText),
          nonCanonicalDiscovery: true
        },
        ...parseCompensation(metaText)
      });
    });
    const discoveredJobs = jobs.length > 0
      ? jobs
      : extractListing($, sourceUrl, "linkedin", {
          title: ".base-search-card__title, .job-search-card__title, h3.base-search-card__title, h3",
          link: "a.base-card__full-link, a.base-card__link, a[href*='/jobs/view/']",
          company: ".base-search-card__subtitle, .job-search-card__subtitle, h4.base-search-card__subtitle",
          location: ".job-search-card__location, .base-search-card__metadata, .job-search-card__listdate",
          meta: ".base-search-card__metadata, time"
        }).map((listing) => ({
          ...listing,
          postedAt: listing.postedAt ?? parseRelativePostedAt(listing.description ?? ""),
          metadata: {
            ...(listing.metadata ?? {}),
            nonCanonicalDiscovery: true
          }
        }));

    if (discoveredJobs.length > 0) {
      return discoveredJobs.map((listing) => ({
        ...listing,
        metadata: {
          ...(listing.metadata ?? {}),
          ...(isLinkedInUrl(listing.applyUrl) ? { linkedinHostedApply: true } : {})
        }
      }));
    }
    const direct = parseLinkedInDirectListing($, sourceUrl);
    if (direct == null) {
      return [];
    }
    if (!isLinkedInUrl(direct.applyUrl)) {
      return [direct];
    }
    return [{
      ...direct,
      metadata: {
        ...(direct.metadata ?? {}),
        linkedinHostedApply: true
      }
    }];
  }
};

export const levelsAdapter: PortalAdapter = {
  portal: "levels",
  matches: (sourceUrl) => /levels\.fyi/i.test(sourceUrl),
  discoverListings(html, sourceUrl) {
    const fromLocationPage = parseLevelsLocationPage(html, sourceUrl);
    if (fromLocationPage.length > 0) {
      return fromLocationPage;
    }
    const fromNextData = parseLevelsNextData(html, sourceUrl);
    if (fromNextData.length > 0) {
      return fromNextData;
    }
    const $ = load(html);
    const jobs = extractListing($, sourceUrl, "levels", {
      title: "h3, h4, [class*='title']",
      link: "a[href*='/jobs/'], a[href*='greenhouse'], a[href*='lever'], a[href*='ashby'], a[href*='workday']",
      company: "[class*='company']",
      location: "[class*='location']",
      meta: "p, span"
    }).map((listing) => ({
      ...listing,
      metadata: {
        ...(listing.metadata ?? {}),
        nonCanonicalDiscovery: true
      }
    }));
    if (jobs.length > 0) {
      return jobs;
    }
    const direct = parseLevelsDirectListing($, sourceUrl);
    return direct == null ? [] : [direct];
  }
};

export const genericCareersAdapter: PortalAdapter = {
  portal: "generic",
  matches: () => true,
  discoverListings(html, sourceUrl) {
    if (/workopolis\.com/i.test(sourceUrl)) {
      const workopolisListings = parseWorkopolisSearchListings(html, sourceUrl);
      if (workopolisListings.length > 0) {
        return workopolisListings;
      }
    }
    const $ = load(html);
    const listings = extractListing($, sourceUrl, "generic", {
      title: "h2, h3, h4",
      link: "a[href*='job'], a[href*='career'], a[href*='position']",
      location: ".location, [class*='location']",
      meta: "p, .meta"
    });
    return listings.filter((listing) => /analyst|scientist|engineer|developer|platform|solutions|automation|product/i.test(listing.title));
  }
};

export const portalAdapters: PortalAdapter[] = [
  greenhouseAdapter,
  leverAdapter,
  ashbyAdapter,
  workdayAdapter,
  linkedinAdapter,
  levelsAdapter,
  genericCareersAdapter
];

export function chooseAdapter(sourceUrl: string, preferredKind?: SourceKind | string): PortalAdapter {
  if (preferredKind) {
    const byKind = portalAdapters.find((adapter) => adapter.portal === preferredKind);
    if (byKind) {
      return byKind;
    }
  }
  return portalAdapters.find((adapter) => adapter.matches(sourceUrl)) ?? genericCareersAdapter;
}
