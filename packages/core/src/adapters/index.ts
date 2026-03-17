import { load } from "cheerio";
import type { JobListing, PortalAdapter } from "../types";

function parseCompensation(text: string | undefined): { salaryMin?: number; salaryMax?: number; compensationText?: string } {
  if (!text) {
    return {};
  }
  const numbers = Array.from(text.matchAll(/\$?([0-9]{2,3}(?:,[0-9]{3})?)/g)).map((match) => Number(match[1].replace(/,/g, "")));
  return {
    salaryMin: numbers[0],
    salaryMax: numbers[1],
    compensationText: text.trim()
  };
}

function absoluteUrl(base: string, href: string | undefined): string {
  if (!href) {
    return base;
  }
  return new URL(href, base).toString();
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
      company: selectors.company ? card.find(selectors.company).first().text().trim() || new URL(sourceUrl).hostname : new URL(sourceUrl).hostname,
      title,
      location: selectors.location ? card.find(selectors.location).first().text().trim() || "Unknown" : "Unknown",
      description: metaText,
      metadata: metaText ? parseCompensation(metaText) : undefined,
      ...parseCompensation(metaText)
    });
  });
  return jobs;
}

export const greenhouseAdapter: PortalAdapter = {
  portal: "greenhouse",
  matches: (sourceUrl) => /greenhouse\.io/i.test(sourceUrl),
  discoverListings(html, sourceUrl) {
    const $ = load(html);
    return extractListing($, sourceUrl, "greenhouse", {
      title: ".opening",
      link: "a[href*='/jobs/'], a.opening",
      location: ".location",
      meta: ".location"
    });
  }
};

export const leverAdapter: PortalAdapter = {
  portal: "lever",
  matches: (sourceUrl) => /lever\.co/i.test(sourceUrl),
  discoverListings(html, sourceUrl) {
    const $ = load(html);
    return extractListing($, sourceUrl, "lever", {
      title: ".posting-title h5, .posting-title",
      link: "a[href*='/jobs'], a.posting-title",
      location: ".posting-categories .sort-by-location, .location",
      meta: ".posting-categories"
    });
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

export const genericCareersAdapter: PortalAdapter = {
  portal: "generic",
  matches: () => true,
  discoverListings(html, sourceUrl) {
    const $ = load(html);
    const listings = extractListing($, sourceUrl, "generic", {
      title: "h2, h3, h4",
      link: "a[href*='job'], a[href*='career'], a[href*='position']",
      location: ".location, [class*='location']",
      meta: "p, .meta"
    });
    return listings.filter((listing) => /engineer|developer|platform|solutions|automation|product/i.test(listing.title));
  }
};

export const portalAdapters: PortalAdapter[] = [
  greenhouseAdapter,
  leverAdapter,
  ashbyAdapter,
  workdayAdapter,
  genericCareersAdapter
];

export function chooseAdapter(sourceUrl: string): PortalAdapter {
  return portalAdapters.find((adapter) => adapter.matches(sourceUrl)) ?? genericCareersAdapter;
}
