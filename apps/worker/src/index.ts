import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { chromium, type BrowserContext, type Locator, type Page } from "playwright";
import { Command } from "commander";
import PQueue from "p-queue";
import { normalizeLevelsSourceUrl, normalizeLinkedInSourceUrl } from "./source-url";
import {
  canTransition,
  CareerOpsPipeline,
  RESUME_FEEDBACK_OUTCOMES,
  SOURCE_KINDS,
  ensureDataPaths,
  ensureReviewRequired,
  loadRootEnv,
  type ApplicationDraft,
  type ApplicationState,
  type CareerSource,
  type EvaluationReport,
  type JobListing,
  type JobRecordWithArtifacts,
  type ResumeFeedbackOutcome,
  type SourceKind,
  type SourceSyncRun
} from "@career-ops/core";

function resolveRootDir(): string {
  const cwd = path.resolve(process.cwd());
  const candidates = [
    cwd,
    path.resolve(cwd, ".."),
    path.resolve(cwd, "..", "..")
  ];
  for (const candidate of candidates) {
    if (existsSync(path.resolve(candidate, "config", "regions.json"))) {
      return candidate;
    }
  }
  return cwd;
}

const rootDir = resolveRootDir();
loadRootEnv(rootDir);
const { dbPath, browserProfileDir } = ensureDataPaths(rootDir);
const program = new Command();
const DEFAULT_HTTP_HEADERS = {
  "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36",
  "accept-language": "en-US,en;q=0.9"
};
const LINKEDIN_FETCH_TIMEOUT_MS = Number(process.env.CAREER_OPS_LINKEDIN_FETCH_TIMEOUT_MS ?? 20000);
const LINKEDIN_GUEST_MAX_ATTEMPTS = Number(process.env.CAREER_OPS_LINKEDIN_GUEST_MAX_ATTEMPTS ?? 3);
const LINKEDIN_GUEST_RETRY_BASE_MS = Number(process.env.CAREER_OPS_LINKEDIN_GUEST_RETRY_BASE_MS ?? 1250);
const LINKEDIN_GUEST_PAGE_DELAY_MS = Number(process.env.CAREER_OPS_LINKEDIN_GUEST_PAGE_DELAY_MS ?? 300);
const LINKEDIN_EXTERNAL_RESOLVE_LIMIT = Number(process.env.CAREER_OPS_LINKEDIN_EXTERNAL_RESOLVE_LIMIT ?? 25);
const LINKEDIN_JOB_DETAIL_MAX_ATTEMPTS = Number(process.env.CAREER_OPS_LINKEDIN_JOB_DETAIL_MAX_ATTEMPTS ?? 2);
const LINKEDIN_JOB_DETAIL_RETRY_BASE_MS = Number(process.env.CAREER_OPS_LINKEDIN_JOB_DETAIL_RETRY_BASE_MS ?? 500);
const SOURCE_API_FETCH_TIMEOUT_MS = Number(process.env.CAREER_OPS_SOURCE_API_FETCH_TIMEOUT_MS ?? 20000);
const SOURCE_SYNC_TIMEOUT_MS = Number(process.env.CAREER_OPS_SOURCE_SYNC_TIMEOUT_MS ?? 120000);
const PERSISTENT_FETCH_QUEUE = new PQueue({ concurrency: 1 });
const BOT_PROTECTED_HOST_PATTERNS = [
  /(^|\.)indeed\.[a-z.]+$/i,
  /(^|\.)workopolis\.com$/i,
  /(^|\.)simplyhired\.(com|ca)$/i
];
const ACCESS_DENIED_PATTERNS = [
  /request denied/i,
  /access denied/i,
  /attention required/i,
  /unusual traffic/i,
  /verify (you|that you) (are|re) human/i,
  /are you (a )?robot/i,
  /captcha/i
];

function demoJobs(): JobListing[] {
  return [
    {
      portal: "greenhouse",
      sourceUrl: "https://boards.greenhouse.io/example",
      applyUrl: "https://boards.greenhouse.io/example/jobs/1001",
      company: "n8n",
      title: "Staff LLM Interaction Engineer",
      location: "Remote, United States",
      postedAt: new Date().toISOString(),
      compensationText: "$210,000 - $250,000",
      salaryMin: 210000,
      salaryMax: 250000,
      description: "Build agent workflows, evaluation loops, and LLM platform capabilities with TypeScript and automation."
    },
    {
      portal: "lever",
      sourceUrl: "https://jobs.lever.co/example",
      applyUrl: "https://jobs.lever.co/example/1002",
      company: "Zapier",
      title: "Automation Strategist",
      location: "Remote, US",
      compensationText: "$140,000 - $165,000",
      salaryMin: 140000,
      salaryMax: 165000,
      description: "Customer-facing automation role focused on onboarding and enablement."
    },
    {
      portal: "ashby",
      sourceUrl: "https://jobs.ashbyhq.com/example",
      applyUrl: "https://jobs.ashbyhq.com/example/job/1003",
      company: "Grafana Labs",
      title: "Senior Solutions Engineer",
      location: "Remote, United States",
      compensationText: "$190,000 - $220,000",
      salaryMin: 190000,
      salaryMax: 220000,
      description: "Own pre-sales technical discovery, demos, and AI observability workflows."
    }
  ];
}

function isBotProtectedSourceUrl(sourceUrl: string): boolean {
  try {
    const hostname = new URL(sourceUrl).hostname.toLowerCase();
    return BOT_PROTECTED_HOST_PATTERNS.some((pattern) => pattern.test(hostname));
  } catch {
    return false;
  }
}

function isLikelyAccessDeniedHtml(html: string): boolean {
  if (html.trim().length === 0) {
    return true;
  }
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = (titleMatch?.[1] ?? "").replace(/\s+/g, " ").trim();
  if (ACCESS_DENIED_PATTERNS.some((pattern) => pattern.test(title))) {
    return true;
  }
  return ACCESS_DENIED_PATTERNS.some((pattern) => pattern.test(html));
}

async function fetchPageHtmlUnqueued(url: string, options: { persistent?: boolean } = {}): Promise<string> {
  let context: BrowserContext | undefined;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    if (options.persistent) {
      mkdirSync(browserProfileDir, { recursive: true });
      context = await chromium.launchPersistentContext(browserProfileDir, {
        channel: "chrome",
        headless: false
      });
    } else {
      browser = await chromium.launch({ headless: true });
      context = await browser.newContext();
    }

    const page = context.pages()[0] ?? await context.newPage();
    await page.goto(url, { waitUntil: "commit", timeout: 45000 });
    await page.waitForLoadState("domcontentloaded", { timeout: 15000 }).catch(() => undefined);
    await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => undefined);
    await page.waitForTimeout(3000).catch(() => undefined);
    return await page.content();
  } catch (error) {
    if (options.persistent) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Persistent browser sync failed for ${url}. Career Ops uses a single shared browser profile at ${browserProfileDir}, so only one persistent source can run at a time. The worker now serializes those sources automatically. If this still fails, close any Chrome window using that profile and try again. Original error: ${message}`
      );
    }
    throw error;
  } finally {
    await context?.close();
    await browser?.close();
  }
}

async function fetchPageHtml(url: string, options: { persistent?: boolean } = {}): Promise<string> {
  if (options.persistent) {
    const html = await PERSISTENT_FETCH_QUEUE.add(() => fetchPageHtmlUnqueued(url, options));
    if (typeof html !== "string") {
      throw new Error(`Persistent fetch returned no HTML for ${url}`);
    }
    return html;
  }
  return fetchPageHtmlUnqueued(url, options);
}

async function fetchWithTimeout(url: URL, options: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("aborted") || message.includes("AbortError")) {
      throw new Error(`Request to ${url.toString()} timed out after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function withTimeout<T>(task: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    task.then((value) => {
      clearTimeout(timeout);
      resolve(value);
    }).catch((error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

async function sleep(ms: number): Promise<void> {
  if (ms <= 0) {
    return;
  }
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function isLinkedInGuestRateLimitStatus(status: number): boolean {
  return status === 429 || status === 403 || status === 999;
}

function isLinkedInGuestRateLimitError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /LinkedIn guest search returned (429|403|999)/i.test(message);
}

function containsLinkedInSearchCards(html: string): boolean {
  return /base-search-card|job-search-card|jobs-search__results-list|jobs-search-results-list/i.test(html);
}

function decodeHtmlAttribute(value: string): string {
  return value
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;/gi, "'")
    .replace(/&#x2F;/gi, "/");
}

function escapeHtmlAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;");
}

function stripHtmlTags(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function decodeCodeCommentValue(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length >= 2 && (
    (trimmed.startsWith("\"") && trimmed.endsWith("\""))
    || (trimmed.startsWith("'") && trimmed.endsWith("'"))
  )) {
    return trimmed
      .slice(1, -1)
      .replace(/\\u0026/gi, "&")
      .replace(/\\\\/g, "\\")
      .replace(/\\"/g, "\"");
  }
  return trimmed;
}

function isLinkedInHost(hostname: string): boolean {
  return /(^|\.)linkedin\.com$/i.test(hostname);
}

function isLinkedInJobViewUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return isLinkedInHost(parsed.hostname) && /\/jobs\/view\//i.test(parsed.pathname);
  } catch {
    return /linkedin\.com\/jobs\/view\//i.test(url);
  }
}

function toAbsoluteLinkedInUrl(rawHref: string): string | null {
  try {
    return new URL(rawHref, "https://www.linkedin.com").toString();
  } catch {
    return null;
  }
}

function resolveExternalApplyCandidate(rawHref: string, baseUrl: string): string | null {
  try {
    const absoluteHref = new URL(rawHref, baseUrl);
    if (!isLinkedInHost(absoluteHref.hostname)) {
      return absoluteHref.toString();
    }

    for (const key of ["url", "redirect", "redirectUrl", "target", "session_redirect"]) {
      const target = absoluteHref.searchParams.get(key);
      if (target == null || target.trim().length === 0) {
        continue;
      }
      const candidates = [target];
      try {
        candidates.push(decodeURIComponent(target));
      } catch {
        // Best effort decode only.
      }
      for (const candidate of candidates) {
        try {
          const targetUrl = new URL(candidate, absoluteHref);
          if (!isLinkedInHost(targetUrl.hostname)) {
            return targetUrl.toString();
          }
        } catch {
          continue;
        }
      }
    }
  } catch {
    return null;
  }
  return null;
}

function extractLinkedInJobViewUrlsFromGuestHtml(html: string): string[] {
  const urls = new Set<string>();
  const hrefPattern = /href="([^"]+)"/gi;
  let match: RegExpExecArray | null;
  while ((match = hrefPattern.exec(html)) != null) {
    const decodedHref = decodeHtmlAttribute(match[1]);
    const absoluteHref = toAbsoluteLinkedInUrl(decodedHref);
    if (!absoluteHref || !isLinkedInJobViewUrl(absoluteHref)) {
      continue;
    }
    urls.add(absoluteHref);
  }
  return Array.from(urls);
}

function extractExternalApplyUrlFromLinkedInCodeBlocks(html: string, jobUrl: string): string | null {
  const codePattern = /<code\b[^>]*id="([^"]+)"[^>]*>\s*<!--([\s\S]*?)-->\s*<\/code>/gi;
  let match: RegExpExecArray | null;
  while ((match = codePattern.exec(html)) != null) {
    const codeId = match[1].toLowerCase();
    if (!/(apply|offsite|company[_-]?web[si]te)/i.test(codeId)) {
      continue;
    }
    const decoded = decodeHtmlAttribute(decodeCodeCommentValue(match[2]));
    const resolved = resolveExternalApplyCandidate(decoded, jobUrl);
    if (resolved != null) {
      return resolved;
    }
  }
  return null;
}

function extractExternalApplyUrlFromLinkedInJobHtml(html: string, jobUrl: string): string | null {
  const codeResolved = extractExternalApplyUrlFromLinkedInCodeBlocks(html, jobUrl);
  if (codeResolved != null) {
    return codeResolved;
  }

  const anchorPattern = /<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let match: RegExpExecArray | null;
  while ((match = anchorPattern.exec(html)) != null) {
    const markup = match[0].toLowerCase();
    const text = stripHtmlTags(match[2]).toLowerCase();
    const looksApplyLink = markup.includes("topcard__apply-link")
      || (markup.includes("tracking-control-name") && markup.includes("apply"))
      || markup.includes("company_webiste")
      || markup.includes("company_website")
      || markup.includes("offsite")
      || /\bapply\b/.test(text);
    if (!looksApplyLink) {
      continue;
    }

    const decodedHref = decodeHtmlAttribute(match[1]);
    const absoluteHref = toAbsoluteLinkedInUrl(decodedHref) ?? new URL(decodedHref, jobUrl).toString();
    if (isLinkedInJobViewUrl(absoluteHref)) {
      continue;
    }
    const resolved = resolveExternalApplyCandidate(decodedHref, jobUrl);
    if (resolved != null) {
      return resolved;
    }
  }
  return null;
}

interface LinkedInResolvedJobDetails {
  externalApplyUrl?: string;
  compensationText?: string;
}

function extractLinkedInCompensationSnippet(text: string): string | null {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length === 0) {
    return null;
  }

  const hasCompensationKeyword = /\b(?:salary|compensation|pay range|pay rate|base pay|base salary|hourly|annually|per year|per hour|ote|bonus|equity)\b/i;
  const hasMoneySignal = /(?:[$\u00A3\u20AC\u00A5\u20B9]\s*\d[\d,.]*(?:\s*[KM])?|\b(?:cad|usd|eur|gbp)\b\s*\d[\d,.]*(?:\s*[KM])?|\b\d{2,3}\s*[KM]\b)/i;
  const hasMoneyRangeSignal = /(?:[$\u00A3\u20AC\u00A5\u20B9]\s*\d[\d,.]*(?:\s*[KM])?\s*(?:-|\u2013|to)\s*(?:[$\u00A3\u20AC\u00A5\u20B9]\s*)?\d[\d,.]*(?:\s*[KM])?)/i;
  const moneyTokenPattern = /(?:[$\u00A3\u20AC\u00A5\u20B9]\s*\d[\d,.]*(?:\s*[KM])?|\b(?:cad|usd|eur|gbp)\b\s*\d[\d,.]*(?:\s*[KM])?)/i;

  const buildFocusedSnippet = (source: string): string => {
    const trimmed = source.trim();
    const rangeMatch = trimmed.match(hasMoneyRangeSignal);
    if (rangeMatch?.[0]) {
      return rangeMatch[0].trim().slice(0, 280);
    }
    const moneyMatch = moneyTokenPattern.exec(trimmed);
    if (moneyMatch?.index != null) {
      const keywordPattern = /\b(?:salary|compensation|pay range|pay rate|base pay|base salary|hourly|annually|per year|per hour|ote|bonus|equity)\b/gi;
      let keywordStart = -1;
      let keywordMatch: RegExpExecArray | null;
      while ((keywordMatch = keywordPattern.exec(trimmed)) != null) {
        if (keywordMatch.index > moneyMatch.index) {
          break;
        }
        keywordStart = keywordMatch.index;
      }
      const start = keywordStart >= 0 && (moneyMatch.index - keywordStart) <= 120
        ? keywordStart
        : moneyMatch.index;
      return trimmed.slice(start, start + 280).trim();
    }
    return trimmed.slice(0, 280);
  };

  const rangeMatch = normalized.match(hasMoneyRangeSignal);
  if (rangeMatch?.[0]) {
    return rangeMatch[0].trim().slice(0, 280);
  }

  const segments = normalized
    .split(/\s*[|\u00B7]\s*/)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
  for (const segment of segments) {
    if (hasCompensationKeyword.test(segment) && hasMoneySignal.test(segment)) {
      return buildFocusedSnippet(segment);
    }
  }

  const sentences = normalized
    .split(/(?<=[.!?])\s+|\n+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0);
  for (const sentence of sentences) {
    if (hasCompensationKeyword.test(sentence) && hasMoneySignal.test(sentence)) {
      return buildFocusedSnippet(sentence);
    }
  }
  return null;
}

function extractLinkedInTopCardCompensationHint(html: string): string | null {
  const topCardMatch = html.match(
    /<section[^>]*class="[^"]*top-card-layout[^"]*"[^>]*>([\s\S]*?)<\/section>/i
  );
  if (topCardMatch == null) {
    return null;
  }
  const topCardText = stripHtmlTags(decodeHtmlAttribute(topCardMatch[1])).replace(/\s+/g, " ").trim();
  if (topCardText.length === 0) {
    return null;
  }
  return extractLinkedInCompensationSnippet(topCardText);
}

function extractLinkedInJobPostingJsonLdDescription(html: string): string | null {
  const scriptPattern = /<script\b[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi;
  let match: RegExpExecArray | null;
  while ((match = scriptPattern.exec(html)) != null) {
    const rawJson = decodeHtmlAttribute(match[1]).trim();
    if (rawJson.length === 0) {
      continue;
    }
    try {
      const parsed = JSON.parse(rawJson);
      const entries = Array.isArray(parsed) ? parsed : [parsed];
      for (const entry of entries) {
        if (entry == null || typeof entry !== "object") {
          continue;
        }
        const record = entry as Record<string, unknown>;
        const type = record["@type"];
        const isJobPosting = type === "JobPosting" || (Array.isArray(type) && type.includes("JobPosting"));
        if (!isJobPosting) {
          continue;
        }
        const description = record.description;
        if (typeof description !== "string") {
          continue;
        }
        const normalized = stripHtmlTags(decodeHtmlAttribute(description)).replace(/\s+/g, " ").trim();
        if (normalized.length > 0) {
          return normalized;
        }
      }
    } catch {
      continue;
    }
  }
  return null;
}

function extractLinkedInDescriptionCompensationHint(html: string): string | null {
  const descriptionMatch = html.match(
    /<div[^>]*class="[^"]*(?:show-more-less-html__markup|description__text--rich|description__text)[^"]*"[^>]*>([\s\S]*?)<\/div>/i
  );
  const candidates: string[] = [];
  if (descriptionMatch != null) {
    const descriptionText = stripHtmlTags(decodeHtmlAttribute(descriptionMatch[1])).replace(/\s+/g, " ").trim();
    if (descriptionText.length > 0) {
      candidates.push(descriptionText);
    }
  }
  const jsonLdDescription = extractLinkedInJobPostingJsonLdDescription(html);
  if (jsonLdDescription != null) {
    candidates.push(jsonLdDescription);
  }
  for (const candidate of candidates) {
    const snippet = extractLinkedInCompensationSnippet(candidate);
    if (snippet != null) {
      return snippet;
    }
  }
  return null;
}

function extractLinkedInCompensationTextFromJobHtml(html: string): string | undefined {
  const topCardHint = extractLinkedInTopCardCompensationHint(html);
  if (topCardHint != null) {
    return topCardHint;
  }
  const descriptionHint = extractLinkedInDescriptionCompensationHint(html);
  return descriptionHint ?? undefined;
}

async function resolveLinkedInJobDetails(jobViewUrls: string[]): Promise<Map<string, LinkedInResolvedJobDetails>> {
  const resolved = new Map<string, LinkedInResolvedJobDetails>();
  if (jobViewUrls.length === 0) {
    return resolved;
  }
  const queue = new PQueue({ concurrency: 2 });
  await Promise.all(
    jobViewUrls.map((jobUrl) => queue.add(async () => {
      for (let attempt = 1; attempt <= LINKEDIN_JOB_DETAIL_MAX_ATTEMPTS; attempt += 1) {
        try {
          const response = await fetchWithTimeout(new URL(jobUrl), { headers: DEFAULT_HTTP_HEADERS }, LINKEDIN_FETCH_TIMEOUT_MS);
          if (!response.ok) {
            if (isLinkedInGuestRateLimitStatus(response.status) && attempt < LINKEDIN_JOB_DETAIL_MAX_ATTEMPTS) {
              await sleep(LINKEDIN_JOB_DETAIL_RETRY_BASE_MS * attempt);
              continue;
            }
            return;
          }
          const html = await response.text();
          const externalApplyUrl = extractExternalApplyUrlFromLinkedInJobHtml(html, jobUrl);
          const compensationText = extractLinkedInCompensationTextFromJobHtml(html);
          if (externalApplyUrl == null && compensationText == null) {
            return;
          }
          resolved.set(jobUrl, {
            externalApplyUrl: externalApplyUrl ?? undefined,
            compensationText
          });
          return;
        } catch {
          if (attempt < LINKEDIN_JOB_DETAIL_MAX_ATTEMPTS) {
            await sleep(LINKEDIN_JOB_DETAIL_RETRY_BASE_MS * attempt);
            continue;
          }
          return;
        }
      }
    }))
  );
  return resolved;
}

function rewriteLinkedInGuestCardLinks(html: string, resolvedJobDetails: Map<string, LinkedInResolvedJobDetails>): string {
  if (resolvedJobDetails.size === 0) {
    return html;
  }
  return html.replace(/href="([^"]+)"/gi, (fullMatch, rawHref: string) => {
    const decodedHref = decodeHtmlAttribute(rawHref);
    const absoluteHref = toAbsoluteLinkedInUrl(decodedHref);
    if (!absoluteHref) {
      return fullMatch;
    }
    const details = resolvedJobDetails.get(absoluteHref);
    if (details == null) {
      return fullMatch;
    }
    const rewrittenHref = details.externalApplyUrl ?? absoluteHref;
    const compensationAttribute = details.compensationText != null
      ? ` data-linkedin-compensation="${escapeHtmlAttribute(details.compensationText)}"`
      : "";
    return `href="${escapeHtmlAttribute(rewrittenHref)}"${compensationAttribute}`;
  });
}

async function fetchLinkedInGuestPageHtml(guestUrl: URL): Promise<string> {
  let lastError: Error | undefined;
  for (let attempt = 1; attempt <= LINKEDIN_GUEST_MAX_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetchWithTimeout(guestUrl, { headers: DEFAULT_HTTP_HEADERS }, LINKEDIN_FETCH_TIMEOUT_MS);
      if (response.ok) {
        return await response.text();
      }
      if (!isLinkedInGuestRateLimitStatus(response.status)) {
        throw new Error(`LinkedIn guest search returned ${response.status} ${response.statusText}`);
      }
      lastError = new Error(`LinkedIn guest search returned ${response.status} ${response.statusText}`);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
    if (attempt < LINKEDIN_GUEST_MAX_ATTEMPTS) {
      await sleep(LINKEDIN_GUEST_RETRY_BASE_MS * attempt);
    }
  }
  throw lastError ?? new Error("LinkedIn guest search failed.");
}

async function fetchLinkedInGuestSearchHtml(sourceUrl: string): Promise<string> {
  const source = new URL(normalizeLinkedInSourceUrl(sourceUrl));
  const guestUrl = new URL("https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search");
  for (const [key, value] of source.searchParams.entries()) {
    guestUrl.searchParams.set(key, value);
  }

  const pages: string[] = [];
  let remainingResolveBudget = Math.max(0, LINKEDIN_EXTERNAL_RESOLVE_LIMIT);
  const seenJobViewUrls = new Set<string>();
  for (let start = 0; start < 75; start += 25) {
    guestUrl.searchParams.set("start", String(start));
    const html = await fetchLinkedInGuestPageHtml(guestUrl);
    if (!containsLinkedInSearchCards(html)) {
      break;
    }
    const jobViewUrls = remainingResolveBudget > 0
      ? extractLinkedInJobViewUrlsFromGuestHtml(html)
          .filter((jobUrl) => {
            if (seenJobViewUrls.has(jobUrl)) {
              return false;
            }
            seenJobViewUrls.add(jobUrl);
            return true;
          })
          .slice(0, remainingResolveBudget)
      : [];
    remainingResolveBudget -= jobViewUrls.length;
    const resolvedJobDetails = await resolveLinkedInJobDetails(jobViewUrls);
    const rewrittenHtml = rewriteLinkedInGuestCardLinks(html, resolvedJobDetails);
    pages.push(rewrittenHtml);
    const pageCardCount = (html.match(/base-search-card--link|job-search-card/g) ?? []).length;
    if (pageCardCount < 25) {
      break;
    }
    await sleep(LINKEDIN_GUEST_PAGE_DELAY_MS);
  }

  if (pages.length === 0) {
    throw new Error(`LinkedIn guest search returned no job cards for ${sourceUrl}`);
  }

  return `<html><body><ul>${pages.join("\n")}</ul></body></html>`;
}

function parseGreenhouseBoardToken(sourceUrl: string): string | null {
  try {
    const parsed = new URL(sourceUrl);
    const tokenFromQuery = parsed.searchParams.get("for")?.trim();
    if (tokenFromQuery) {
      return tokenFromQuery;
    }

    const hostname = parsed.hostname.replace(/^www\./i, "").toLowerCase();
    const segments = parsed.pathname.split("/").filter(Boolean);
    if (!hostname.endsWith("greenhouse.io")) {
      return null;
    }

    if (hostname === "boards.greenhouse.io" || hostname === "job-boards.greenhouse.io") {
      const reserved = new Set(["embed", "job_board", "jobs", "board", "boards"]);
      const token = segments.find((segment) => !reserved.has(segment.toLowerCase()));
      return token ?? null;
    }

    const subdomain = hostname.split(".")[0];
    if (subdomain && subdomain !== "boards" && subdomain !== "job-boards") {
      return subdomain;
    }
  } catch {
    return null;
  }
  return null;
}

function parseLeverSiteToken(sourceUrl: string): string | null {
  try {
    const parsed = new URL(sourceUrl);
    const hostname = parsed.hostname.replace(/^www\./i, "").toLowerCase();
    const segments = parsed.pathname.split("/").filter(Boolean);

    if (hostname === "jobs.lever.co" || hostname.endsWith(".jobs.lever.co")) {
      return segments[0] ?? null;
    }

    if (hostname === "api.lever.co" || hostname.endsWith(".api.lever.co")) {
      const postingsIndex = segments.findIndex((segment) => segment.toLowerCase() === "postings");
      if (postingsIndex >= 0 && segments[postingsIndex + 1]) {
        return segments[postingsIndex + 1];
      }
    }

    if (hostname.endsWith("lever.co")) {
      return segments[0] ?? null;
    }
  } catch {
    return null;
  }
  return null;
}

async function fetchGreenhouseApiPayload(sourceUrl: string): Promise<string> {
  const boardToken = parseGreenhouseBoardToken(sourceUrl);
  if (boardToken == null) {
    throw new Error(`Unable to infer Greenhouse board token from ${sourceUrl}`);
  }
  const apiUrl = new URL(`https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(boardToken)}/jobs`);
  apiUrl.searchParams.set("content", "true");
  const response = await fetchWithTimeout(apiUrl, { headers: DEFAULT_HTTP_HEADERS }, SOURCE_API_FETCH_TIMEOUT_MS);
  if (!response.ok) {
    throw new Error(`Greenhouse API returned ${response.status} ${response.statusText} for board ${boardToken}`);
  }
  return await response.text();
}

async function fetchLeverApiPayload(sourceUrl: string): Promise<string> {
  const siteToken = parseLeverSiteToken(sourceUrl);
  if (siteToken == null) {
    throw new Error(`Unable to infer Lever site token from ${sourceUrl}`);
  }
  const apiUrl = new URL(`https://api.lever.co/v0/postings/${encodeURIComponent(siteToken)}`);
  apiUrl.searchParams.set("mode", "json");
  const response = await fetchWithTimeout(apiUrl, { headers: DEFAULT_HTTP_HEADERS }, SOURCE_API_FETCH_TIMEOUT_MS);
  if (!response.ok) {
    throw new Error(`Lever API returned ${response.status} ${response.statusText} for site ${siteToken}`);
  }
  return await response.text();
}

async function fetchSourceHtml(source: ReturnType<CareerOpsPipeline["listSources"]>[number]): Promise<string> {
  if (source.kind === "linkedin") {
    try {
      return await fetchLinkedInGuestSearchHtml(source.sourceUrl);
    } catch (error) {
      const guestFailureMessage = error instanceof Error ? error.message : String(error);
      if (!isLinkedInGuestRateLimitError(error) && !/no job cards/i.test(guestFailureMessage)) {
        throw error;
      }
      const fallbackHtml = await fetchPageHtml(source.sourceUrl, { persistent: source.usePersistentBrowser });
      if (containsLinkedInSearchCards(fallbackHtml)) {
        return fallbackHtml;
      }
      throw new Error(`LinkedIn guest search failed (${guestFailureMessage}). Browser fallback did not return any search cards.`);
    }
  }
  if (source.kind === "greenhouse") {
    try {
      return await fetchGreenhouseApiPayload(source.sourceUrl);
    } catch {
      return fetchPageHtml(source.sourceUrl, { persistent: source.usePersistentBrowser });
    }
  }
  if (source.kind === "lever") {
    try {
      return await fetchLeverApiPayload(source.sourceUrl);
    } catch {
      return fetchPageHtml(source.sourceUrl, { persistent: source.usePersistentBrowser });
    }
  }
  if (source.kind === "levels") {
    return fetchPageHtml(normalizeLevelsSourceUrl(source.sourceUrl), { persistent: source.usePersistentBrowser });
  }
  const html = await fetchPageHtml(source.sourceUrl, { persistent: source.usePersistentBrowser });
  if (!source.usePersistentBrowser && isBotProtectedSourceUrl(source.sourceUrl) && isLikelyAccessDeniedHtml(html)) {
    try {
      console.warn(`Detected possible anti-bot block for ${source.name}; retrying with persistent browser.`);
      return await fetchPageHtml(source.sourceUrl, { persistent: true });
    } catch {
      return html;
    }
  }
  return html;
}

async function syncOneSource(pipeline: CareerOpsPipeline, source: ReturnType<CareerOpsPipeline["listSources"]>[number]): Promise<SourceSyncRun> {
  const startedAt = new Date().toISOString();
  try {
    return await withTimeout((async () => {
      const html = await fetchSourceHtml(source);
      return pipeline.syncRegisteredSource(source.id, html);
    })(), SOURCE_SYNC_TIMEOUT_MS, `Sync ${source.name}`);
  } catch (error) {
    const completedAt = new Date().toISOString();
    const message = error instanceof Error ? error.message : String(error);
    const run: SourceSyncRun = {
      sourceId: source.id,
      sourceName: source.name,
      sourceUrl: source.sourceUrl,
      regionId: source.regionId,
      startedAt,
      completedAt,
      processed: 0,
      created: 0,
      updated: 0,
      errors: [message],
      status: "error",
      jobIds: []
    };
    pipeline.repo.updateCareerSourceSync(source.id, "error", completedAt);
    pipeline.repo.saveSourceSyncRun(run);
    return run;
  }
}

async function syncSelectedSources(
  pipeline: CareerOpsPipeline,
  sources: ReturnType<CareerOpsPipeline["listSources"]>,
  concurrency: number,
  onSourceSynced?: (run: SourceSyncRun) => void
): Promise<SourceSyncRun[]> {
  const persistentSources = sources.filter((source) => source.usePersistentBrowser);
  const headlessSources = sources.filter((source) => !source.usePersistentBrowser);
  const linkedinSources = headlessSources.filter((source) => source.kind === "linkedin");
  const otherHeadlessSources = headlessSources.filter((source) => source.kind !== "linkedin");
  const queue = new PQueue({ concurrency });

  const headlessRunsPromise = Promise.all(
    otherHeadlessSources.map((source) => queue.add(async () => {
      const run = await syncOneSource(pipeline, source);
      onSourceSynced?.(run);
      return run;
    }))
  );

  const persistentRuns: SourceSyncRun[] = [];
  for (const source of persistentSources) {
    const run = await syncOneSource(pipeline, source);
    onSourceSynced?.(run);
    persistentRuns.push(run);
  }

  const linkedinRuns: SourceSyncRun[] = [];
  for (const source of linkedinSources) {
    const run = await syncOneSource(pipeline, source);
    onSourceSynced?.(run);
    linkedinRuns.push(run);
  }

  const headlessRuns = (await headlessRunsPromise).filter((run): run is SourceSyncRun => run != null);
  return [...persistentRuns, ...headlessRuns, ...linkedinRuns];
}

function shouldEvaluateAfterSync(options: { evaluate?: boolean; skipEvaluate?: boolean }): boolean {
  if (options.skipEvaluate) {
    return false;
  }
  return options.evaluate === true;
}

const SHORTLIST_AUTOAPPLY_STATUSES: ApplicationState[] = ["shortlisted", "resume_ready", "ready_to_apply", "in_review"];
const AUTOAPPLY_DEFAULT_WAIT_MS = 1500;
const AUTOAPPLY_ENV_RESUME = "CAREER_OPS_UPLOADED_RESUME";
const AUTOAPPLY_ENV_INFO = "CAREER_OPS_AUTOAPPLY_INFO_JSON";
const AUTOAPPLY_ENV_SUBMIT = "CAREER_OPS_AUTOAPPLY_SUBMIT";

interface AutoApplyJobResult {
  jobId: number;
  company: string;
  title: string;
  targetUrl: string;
  outcome: "prefilled" | "submitted" | "failed";
  resumeUploaded: boolean;
  roleAnswersUsed: number;
  missingKeys: string[];
  message?: string;
}

interface AutoApplySummary {
  processed: number;
  submitted: number;
  prefilled: number;
  failed: number;
  results: AutoApplyJobResult[];
}

interface AutoApplyOptions {
  resumePath: string;
  additionalAnswers: Record<string, string>;
  submit: boolean;
  headless: boolean;
  waitMs: number;
  limit: number;
}

const ANSWER_KEY_ALIASES: Record<string, string[]> = {
  full_name: ["full name", "legal name", "name"],
  email: ["email", "email address"],
  phone: ["phone", "phone number", "mobile", "mobile phone"],
  location: ["location", "city", "city state"],
  linkedin: ["linkedin", "linkedin url", "linkedin profile"],
  github: ["github", "github url", "github profile"],
  portfolio: ["portfolio", "website", "personal website", "personal site"],
  requires_sponsorship: ["sponsorship", "requires sponsorship", "work authorization", "authorized to work", "visa"],
  race: ["race", "ethnicity"],
  gender: ["gender", "sex"],
  veteran: ["veteran", "protected veteran"],
  disability: ["disability", "disabled"]
};

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function escapeCssAttributeValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, "\\\"");
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values.filter((value) => value.trim().length > 0)));
}

function parseBooleanFlag(value: string | undefined): boolean {
  if (value == null) {
    return false;
  }
  return ["1", "true", "yes", "y", "on"].includes(value.trim().toLowerCase());
}

function isLinkedInUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return /(^|\.)linkedin\.com$/i.test(parsed.hostname);
  } catch {
    return /linkedin\.com/i.test(url);
  }
}

async function waitForPageSettle(page: Page): Promise<void> {
  await page.waitForLoadState("domcontentloaded", { timeout: 15000 }).catch(() => undefined);
  await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => undefined);
}

async function openApplyPage(page: Page, targetUrl: string): Promise<void> {
  await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
  await waitForPageSettle(page);
}

function resolveAnswerTokens(key: string): string[] {
  const normalized = key.trim().toLowerCase();
  const humanized = normalized.replace(/[_-]+/g, " ");
  const aliases = ANSWER_KEY_ALIASES[normalized] ?? [];
  return unique([
    ...aliases,
    humanized,
    normalized
  ]);
}

function resolveRequiredResumePath(resumePathInput: string | undefined): string {
  const resolvedInput = resumePathInput?.trim().length
    ? resumePathInput.trim()
    : process.env[AUTOAPPLY_ENV_RESUME]?.trim();
  if (!resolvedInput) {
    throw new Error(`Resume path is required. Pass --resume <path> or set ${AUTOAPPLY_ENV_RESUME}.`);
  }
  const absolutePath = path.resolve(rootDir, resolvedInput);
  if (!existsSync(absolutePath)) {
    throw new Error(`Resume file not found: ${absolutePath}`);
  }
  return absolutePath;
}

function parseAdditionalAnswersPayload(payload: unknown): Record<string, string> {
  if (payload == null || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Additional answers JSON must be an object of key/value pairs.");
  }
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(payload as Record<string, unknown>)) {
    if (typeof value === "string") {
      result[key] = value;
      continue;
    }
    if (typeof value === "number" || typeof value === "boolean") {
      result[key] = String(value);
      continue;
    }
    if (value == null) {
      continue;
    }
    throw new Error(`Additional answer "${key}" must be a string, number, boolean, or null.`);
  }
  return result;
}

function loadAdditionalAnswersFromPath(filePathInput: string | undefined): Record<string, string> {
  const input = filePathInput?.trim().length
    ? filePathInput.trim()
    : process.env[AUTOAPPLY_ENV_INFO]?.trim();
  if (!input) {
    return {};
  }
  const absolutePath = path.resolve(rootDir, input);
  if (!existsSync(absolutePath)) {
    throw new Error(`Additional answers file not found: ${absolutePath}`);
  }
  const payload = JSON.parse(readFileSync(absolutePath, "utf8")) as unknown;
  return parseAdditionalAnswersPayload(payload);
}

async function tryFillLocator(locator: Locator, value: string): Promise<boolean> {
  if (await locator.count() === 0) {
    return false;
  }
  const field = locator.first();
  if (await field.isDisabled().catch(() => false)) {
    return false;
  }
  const tag = await field.evaluate((element) => String((element as any).tagName ?? "").toLowerCase()).catch(() => "");
  const type = (await field.getAttribute("type"))?.toLowerCase() ?? "";

  if (tag === "select") {
    const normalizedValue = value.trim().toLowerCase();
    let optionValue = await field.evaluate((element, target) => {
      const options = Array.from((element as any).options ?? []) as Array<{ value?: string; label?: string }>;
      const exactMatch = options.find((option) => {
        const optionValue = String(option.value ?? "").toLowerCase();
        const optionLabel = String(option.label ?? "").toLowerCase();
        return optionValue === target || optionLabel === target;
      });
      if (exactMatch) {
        return String(exactMatch.value ?? "");
      }
      const partialMatch = options.find((option) => {
        const optionValue = String(option.value ?? "").toLowerCase();
        const optionLabel = String(option.label ?? "").toLowerCase();
        return optionValue.includes(target) || optionLabel.includes(target);
      });
      return partialMatch ? String(partialMatch.value ?? "") : null;
    }, normalizedValue).catch(() => null as string | null);
    if (optionValue == null) {
      return false;
    }
    await field.selectOption(optionValue).catch(() => undefined);
    const selectedValue = await field.inputValue().catch(() => "");
    return selectedValue.length > 0;
  }

  if (type === "radio" || type === "checkbox") {
    const normalizedValue = value.trim().toLowerCase();
    const controlValue = ((await field.getAttribute("value")) ?? "").trim().toLowerCase();
    if (controlValue.length > 0 && !controlValue.includes(normalizedValue) && !normalizedValue.includes(controlValue)) {
      return false;
    }
    await field.check().catch(() => undefined);
    return await field.isChecked().catch(() => false);
  }

  await field.fill(value).catch(() => undefined);
  const filled = await field.inputValue().catch(() => "");
  return filled.trim().length > 0;
}

async function tryFillWithSelectors(page: Page, selectors: string[], value: string): Promise<boolean> {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if (await tryFillLocator(locator, value)) {
      return true;
    }
  }
  return false;
}

async function fillDraftField(page: Page, key: string, value: string): Promise<boolean> {
  const normalizedKey = key.trim();
  const directSelectors = [
    `input[name="${escapeCssAttributeValue(normalizedKey)}"]`,
    `textarea[name="${escapeCssAttributeValue(normalizedKey)}"]`,
    `select[name="${escapeCssAttributeValue(normalizedKey)}"]`,
    `input[id="${escapeCssAttributeValue(normalizedKey)}"]`,
    `textarea[id="${escapeCssAttributeValue(normalizedKey)}"]`,
    `select[id="${escapeCssAttributeValue(normalizedKey)}"]`
  ];
  if (await tryFillWithSelectors(page, directSelectors, value)) {
    return true;
  }

  const tokens = resolveAnswerTokens(normalizedKey);
  for (const token of tokens) {
    const safeToken = escapeCssAttributeValue(token);
    const tokenSelectors = [
      `input[name*="${safeToken}" i]`,
      `textarea[name*="${safeToken}" i]`,
      `select[name*="${safeToken}" i]`,
      `input[id*="${safeToken}" i]`,
      `textarea[id*="${safeToken}" i]`,
      `select[id*="${safeToken}" i]`,
      `input[aria-label*="${safeToken}" i]`,
      `textarea[aria-label*="${safeToken}" i]`,
      `select[aria-label*="${safeToken}" i]`,
      `input[placeholder*="${safeToken}" i]`,
      `textarea[placeholder*="${safeToken}" i]`
    ];
    if (await tryFillWithSelectors(page, tokenSelectors, value)) {
      return true;
    }

    const tokenPattern = new RegExp(escapeRegExp(token), "i");
    if (await tryFillLocator(page.getByLabel(tokenPattern).first(), value)) {
      return true;
    }
    if (await tryFillLocator(page.getByPlaceholder(tokenPattern).first(), value)) {
      return true;
    }
  }
  return false;
}

async function fillRoleSpecificPrompts(page: Page, prompts: string[]): Promise<number> {
  if (prompts.length === 0) {
    return 0;
  }
  const fields = page.locator("textarea, input[type='text']");
  const count = await fields.count();
  let used = 0;
  for (let index = 0; index < count && used < prompts.length; index += 1) {
    const field = fields.nth(index);
    if (await field.isDisabled().catch(() => false)) {
      continue;
    }
    const value = await field.inputValue().catch(() => "");
    if (value.trim().length > 0) {
      continue;
    }
    const isRolePrompt = await field.evaluate((element) => {
      const attrs = [
        (element as any).getAttribute?.("name") ?? "",
        (element as any).getAttribute?.("id") ?? "",
        (element as any).getAttribute?.("placeholder") ?? "",
        (element as any).getAttribute?.("aria-label") ?? "",
        (element as any).getAttribute?.("data-testid") ?? ""
      ].join(" ").toLowerCase();
      const labels = Array.isArray((element as any).labels)
        ? ((element as any).labels as Array<{ textContent?: string }>).map((label) => label.textContent ?? "").join(" ").toLowerCase()
        : "";
      return /(cover|motivation|why|additional|question|message|summary|tell us|interest)/i.test(`${attrs} ${labels}`);
    }).catch(() => false);
    if (!isRolePrompt) {
      continue;
    }
    await field.fill(prompts[used]).catch(() => undefined);
    const filled = await field.inputValue().catch(() => "");
    if (filled.trim().length > 0) {
      used += 1;
    }
  }
  return used;
}

async function uploadResumeToPage(page: Page, resumePath: string): Promise<boolean> {
  const prioritizedSelectors = [
    "input[type='file'][name*='resume' i]",
    "input[type='file'][id*='resume' i]",
    "input[type='file'][aria-label*='resume' i]",
    "input[type='file'][name*='cv' i]",
    "input[type='file'][id*='cv' i]",
    "input[type='file'][aria-label*='cv' i]"
  ];
  for (const selector of prioritizedSelectors) {
    const locator = page.locator(selector);
    const count = await locator.count();
    for (let index = 0; index < count; index += 1) {
      const input = locator.nth(index);
      if (await input.isDisabled().catch(() => false)) {
        continue;
      }
      await input.setInputFiles(resumePath).catch(() => undefined);
      const uploadedCount = await input.evaluate((element) => Number((element as any).files?.length ?? 0)).catch(() => 0);
      if (uploadedCount > 0) {
        return true;
      }
    }
  }

  const anyFileInputs = page.locator("input[type='file']");
  const total = await anyFileInputs.count();
  for (let index = 0; index < total; index += 1) {
    const input = anyFileInputs.nth(index);
    if (await input.isDisabled().catch(() => false)) {
      continue;
    }
    await input.setInputFiles(resumePath).catch(() => undefined);
    const uploadedCount = await input.evaluate((element) => Number((element as any).files?.length ?? 0)).catch(() => 0);
    if (uploadedCount > 0) {
      return true;
    }
  }
  return false;
}

async function attemptApplicationSubmit(page: Page): Promise<boolean> {
  const submitCandidates: Locator[] = [
    page.locator("button[type='submit']").first(),
    page.locator("input[type='submit']").first(),
    page.getByRole("button", { name: /submit|apply|send application|complete application/i }).first(),
    page.locator("button:has-text('Submit')").first(),
    page.locator("button:has-text('Apply')").first()
  ];

  for (const candidate of submitCandidates) {
    if (await candidate.count() === 0) {
      continue;
    }
    if (await candidate.isDisabled().catch(() => false)) {
      continue;
    }
    const clicked = await candidate.click({ timeout: 8000 }).then(() => true).catch(() => false);
    if (!clicked) {
      continue;
    }
    await page.waitForLoadState("domcontentloaded", { timeout: 12000 }).catch(() => undefined);
    await page.waitForLoadState("networkidle", { timeout: 12000 }).catch(() => undefined);
    await page.waitForTimeout(2000).catch(() => undefined);
    const url = page.url().toLowerCase();
    if (/(thank|submitted|confirmation|complete)/i.test(url)) {
      return true;
    }
    const bodyText = ((await page.textContent("body").catch(() => "")) ?? "").toLowerCase();
    if (/(application submitted|thank you for applying|thanks for applying|we have received your application|application has been received)/i.test(bodyText)) {
      return true;
    }
    return false;
  }
  return false;
}

async function autofillApplication(page: Page, draft: ApplicationDraft, resumePath: string, additionalAnswers: Record<string, string>): Promise<{
  missingKeys: string[];
  roleAnswersUsed: number;
  resumeUploaded: boolean;
}> {
  const mergedAnswers: Record<string, string> = {
    ...draft.answers,
    ...additionalAnswers
  };
  const missingKeys: string[] = [];
  for (const [key, rawValue] of Object.entries(mergedAnswers)) {
    const value = String(rawValue ?? "").trim();
    if (value.length === 0) {
      continue;
    }
    const filled = await fillDraftField(page, key, value);
    if (!filled) {
      missingKeys.push(key);
    }
  }
  const roleAnswersUsed = await fillRoleSpecificPrompts(page, draft.roleSpecificAnswers);
  const resumeUploaded = await uploadResumeToPage(page, resumePath);
  return {
    missingKeys,
    roleAnswersUsed,
    resumeUploaded
  };
}

async function ensureReadyToApplyJob(pipeline: CareerOpsPipeline, jobId: number): Promise<JobRecordWithArtifacts> {
  let record = pipeline.repo.getJobRecord(jobId);
  if (record.job.status === "shortlisted" || record.job.status === "evaluated" || record.resume == null) {
    await pipeline.generateResume(jobId);
    record = pipeline.repo.getJobRecord(jobId);
  }
  if (record.job.status === "resume_ready" || record.application == null) {
    await pipeline.draftApplication(jobId);
    record = pipeline.repo.getJobRecord(jobId);
  }
  if (record.application == null) {
    throw new Error(`No application draft available for job ${jobId}.`);
  }
  ensureReviewRequired(record.application);
  return record;
}

function transitionJobIfAllowed(pipeline: CareerOpsPipeline, jobId: number, nextStatus: ApplicationState): void {
  const currentStatus = pipeline.repo.getJobRecord(jobId).job.status;
  if (canTransition(currentStatus, nextStatus)) {
    pipeline.repo.updateJobStatus(jobId, nextStatus);
  }
}

function parseAutoApplyOptions(raw: {
  resume?: string;
  info?: string;
  submit?: boolean;
  headless?: boolean;
  waitMs?: string;
  limit?: string;
}): AutoApplyOptions {
  const resumePath = resolveRequiredResumePath(raw.resume);
  const additionalAnswers = loadAdditionalAnswersFromPath(raw.info);
  const submit = raw.submit === true || parseBooleanFlag(process.env[AUTOAPPLY_ENV_SUBMIT]);
  const headless = raw.headless === true;
  const waitMs = raw.waitMs == null ? AUTOAPPLY_DEFAULT_WAIT_MS : Number(raw.waitMs);
  if (!Number.isFinite(waitMs) || waitMs < 0) {
    throw new Error(`Invalid --wait-ms value: ${raw.waitMs}`);
  }
  const limit = raw.limit == null ? 0 : Number(raw.limit);
  if (!Number.isFinite(limit) || limit < 0) {
    throw new Error(`Invalid --limit value: ${raw.limit}`);
  }
  return {
    resumePath,
    additionalAnswers,
    submit,
    headless,
    waitMs,
    limit
  };
}

async function runShortlistAutoApply(options: AutoApplyOptions): Promise<AutoApplySummary> {
  const pipeline = new CareerOpsPipeline(rootDir, dbPath);
  let context: BrowserContext | null = null;
  try {
    const candidates = pipeline.repo.listJobs()
      .filter((record) => SHORTLIST_AUTOAPPLY_STATUSES.includes(record.job.status))
      .sort((left, right) => {
        const scoreDiff = (right.evaluation?.totalScore ?? 0) - (left.evaluation?.totalScore ?? 0);
        if (scoreDiff !== 0) {
          return scoreDiff;
        }
        return right.job.id - left.job.id;
      });
    const selected = options.limit > 0 ? candidates.slice(0, options.limit) : candidates;
    if (selected.length === 0) {
      return {
        processed: 0,
        submitted: 0,
        prefilled: 0,
        failed: 0,
        results: []
      };
    }

    mkdirSync(browserProfileDir, { recursive: true });
    context = await chromium.launchPersistentContext(browserProfileDir, {
      channel: "chrome",
      headless: options.headless
    });

    const results: AutoApplyJobResult[] = [];
    for (const candidate of selected) {
      const baseResult = {
        jobId: candidate.job.id,
        company: candidate.job.company,
        title: candidate.job.title,
        targetUrl: candidate.job.applyUrl
      };
      try {
        const prepared = await ensureReadyToApplyJob(pipeline, candidate.job.id);
        const draft = prepared.application;
        if (draft == null) {
          throw new Error(`Application draft missing for job ${candidate.job.id}.`);
        }
        if (isLinkedInUrl(draft.targetUrl)) {
          throw new Error(
            "LinkedIn-hosted apply URLs are excluded from autoapply-shortlist. Use the external ATS/company apply URL or submit manually."
          );
        }
        const page = await context.newPage();
        try {
          await openApplyPage(page, draft.targetUrl);
          if (options.waitMs > 0) {
            await page.waitForTimeout(options.waitMs).catch(() => undefined);
          }
          const autofill = await autofillApplication(page, draft, options.resumePath, options.additionalAnswers);

          const submitted = options.submit ? await attemptApplicationSubmit(page) : false;
          if (submitted) {
            transitionJobIfAllowed(pipeline, candidate.job.id, "in_review");
            transitionJobIfAllowed(pipeline, candidate.job.id, "submitted");
            pipeline.repo.saveApplicationDraft(candidate.job.id, {
              ...draft,
              status: "submitted"
            });
            results.push({
              ...baseResult,
              outcome: "submitted",
              resumeUploaded: autofill.resumeUploaded,
              roleAnswersUsed: autofill.roleAnswersUsed,
              missingKeys: autofill.missingKeys
            });
          } else {
            transitionJobIfAllowed(pipeline, candidate.job.id, "in_review");
            pipeline.repo.saveApplicationDraft(candidate.job.id, {
              ...draft,
              status: "reviewed"
            });
            results.push({
              ...baseResult,
              outcome: "prefilled",
              resumeUploaded: autofill.resumeUploaded,
              roleAnswersUsed: autofill.roleAnswersUsed,
              missingKeys: autofill.missingKeys,
              message: options.submit ? "Submit was attempted but confirmation was not detected." : undefined
            });
          }
        } finally {
          await page.close().catch(() => undefined);
        }
      } catch (error) {
        results.push({
          ...baseResult,
          outcome: "failed",
          resumeUploaded: false,
          roleAnswersUsed: 0,
          missingKeys: [],
          message: error instanceof Error ? error.message : String(error)
        });
      }
    }

    return {
      processed: results.length,
      submitted: results.filter((result) => result.outcome === "submitted").length,
      prefilled: results.filter((result) => result.outcome === "prefilled").length,
      failed: results.filter((result) => result.outcome === "failed").length,
      results
    };
  } finally {
    await context?.close().catch(() => undefined);
    pipeline.dispose();
  }
}

async function fillCommonFields(page: Page, draft: ApplicationDraft): Promise<void> {
  for (const [key, value] of Object.entries(draft.answers) as Array<[string, string]>) {
    const selectors = [
      `[name='${key}']`,
      `[id='${key}']`,
      `[aria-label*='${key.replace(/_/g, " ")}']`
    ];
    for (const selector of selectors) {
      const locator = page.locator(selector).first();
      if (await locator.count()) {
        await locator.fill(value).catch(() => undefined);
        break;
      }
    }
  }
}

function readUrlsFromFile(filePath: string): string[] {
  const absolutePath = path.resolve(rootDir, filePath);
  return readFileSync(absolutePath, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
}

function readSourceInput(source: string): string {
  const candidate = path.resolve(rootDir, source);
  return existsSync(candidate) ? readFileSync(candidate, "utf8") : source;
}

function validateSourceKind(kind: string): SourceKind {
  if ((SOURCE_KINDS as readonly string[]).includes(kind)) {
    return kind as SourceKind;
  }
  throw new Error(`Unsupported source kind ${kind}. Expected one of: ${SOURCE_KINDS.join(", ")}`);
}

function parseTagsCsv(value: string | undefined): string[] {
  if (value == null || value.trim().length === 0) {
    return [];
  }
  return Array.from(new Set(
    value
      .split(",")
      .map((tag) => tag.trim())
      .filter((tag) => tag.length > 0)
  ));
}

function validateResumeFeedbackOutcome(outcome: string): ResumeFeedbackOutcome {
  const normalized = outcome.trim().toLowerCase();
  if ((RESUME_FEEDBACK_OUTCOMES as readonly string[]).includes(normalized)) {
    return normalized as ResumeFeedbackOutcome;
  }
  throw new Error(`Unsupported feedback outcome ${outcome}. Expected one of: ${RESUME_FEEDBACK_OUTCOMES.join(", ")}`);
}

function printEvaluationReport(report: EvaluationReport): void {
  console.log(`Summary: ${report.summary}`);
  console.log(`Executive summary: ${report.executiveSummary}`);
  console.log(`Grade: ${report.grade}`);
  console.log(`Total score: ${report.totalScore.toFixed(2)} / 5`);
  console.log(`Decision: ${report.recommendedAction}`);
  console.log(`Archetype: ${report.archetypeLabel}`);
  console.log(`Strongest signals: ${report.strongestSignals.join(" | ")}`);
  console.log(`Risks: ${report.riskSignals.join(" | ") || "n/a"}`);
  console.log("CV match:");
  for (const match of report.cvMatches) {
    console.log(`- [${match.strength}] ${match.requirement}`);
    console.log(`  Proof: ${match.proofPoint}`);
  }
  console.log("Gaps:");
  for (const gap of report.gaps) {
    console.log(`- (${gap.severity}) ${gap.gap}`);
    console.log(`  Mitigation: ${gap.mitigation}`);
  }
  console.log(`Level strategy: ${report.levelStrategy.positioning}`);
  console.log(`Compensation: ${report.compensationView.verdict}`);
  console.log(`Interview likelihood: ${report.interviewView.likelihood}%`);
}

function printTracker(records: JobRecordWithArtifacts[]): void {
  const counts = {
    all: records.length,
    evaluated: records.filter((record) => record.evaluation != null).length,
    rejected: records.filter((record) => record.job.status === "rejected").length,
    shortlist: records.filter((record) => record.job.status === "shortlisted").length,
    resumeReady: records.filter((record) => record.job.status === "resume_ready").length,
    readyToApply: records.filter((record) => record.job.status === "ready_to_apply" || record.job.status === "in_review").length,
    submitted: records.filter((record) => record.job.status === "submitted").length,
    interview: records.filter((record) => record.job.status === "blocked").length
  };
  console.log(JSON.stringify(counts, null, 2));
  console.log("Top opportunities:");
  for (const record of records
    .filter((record) => record.evaluation != null)
    .sort((left, right) => (right.evaluation?.totalScore ?? 0) - (left.evaluation?.totalScore ?? 0))
    .slice(0, 10)) {
    console.log(`- #${record.job.id} ${record.job.company} | ${record.job.title} | ${(record.evaluation?.totalScore ?? 0).toFixed(2)} | ${record.job.status}`);
  }
}

function printSources(sources: ReturnType<CareerOpsPipeline["listSources"]>): void {
  for (const source of sources) {
    const modeLabel = source.kind === "linkedin"
      ? "guest-search"
      : source.usePersistentBrowser
        ? "persistent"
        : "headless";
    console.log(`#${source.id} | ${source.kind} | ${source.regionId} | ${source.active ? "active" : "inactive"} | ${modeLabel}`);
    console.log(`  ${source.name}`);
    console.log(`  ${source.sourceUrl}`);
    console.log(`  last sync: ${source.lastSyncedAt ?? "never"} | status: ${source.lastStatus ?? "idle"}`);
  }
}

function printSourceRuns(runs: SourceSyncRun[]): void {
  for (const run of runs) {
    console.log(`- ${run.sourceName} | ${run.status} | processed=${run.processed} created=${run.created} errors=${run.errors.length}`);
    for (const error of run.errors) {
      console.log(`  ${error}`);
    }
  }
}

program.name("career-ops-worker").description("Career Ops worker CLI");

program
  .command("seed-demo")
  .description("Insert demo jobs into the local database")
  .action(() => {
    const pipeline = new CareerOpsPipeline(rootDir, dbPath);
    try {
      const ids = pipeline.seedDemoJobs(demoJobs());
      console.log(`Seeded ${ids.length} jobs: ${ids.join(", ")}`);
    } finally {
      pipeline.dispose();
    }
  });

program
  .command("clear-listings")
  .description("Delete all job listings and listing-related artifacts from the local database")
  .action(() => {
    const pipeline = new CareerOpsPipeline(rootDir, dbPath);
    try {
      const result = pipeline.repo.clearListings();
      console.log(JSON.stringify(result, null, 2));
    } finally {
      pipeline.dispose();
    }
  });

program
  .command("exclude-company")
  .description("Add or update a globally excluded company")
  .argument("<company>")
  .option("--reason <reason>", "optional exclusion reason")
  .action((company: string, options: { reason?: string }) => {
    const pipeline = new CareerOpsPipeline(rootDir, dbPath);
    try {
      const id = pipeline.excludeCompany(company, options.reason);
      console.log(`Excluded company #${id}: ${company.trim()}`);
    } finally {
      pipeline.dispose();
    }
  });

program
  .command("include-company")
  .description("Remove a company from the global exclusion list")
  .argument("<company>")
  .action((company: string) => {
    const pipeline = new CareerOpsPipeline(rootDir, dbPath);
    try {
      const removed = pipeline.includeCompany(company);
      console.log(removed
        ? `Removed company exclusion: ${company.trim()}`
        : `No exclusion found for: ${company.trim()}`);
    } finally {
      pipeline.dispose();
    }
  });

program
  .command("list-excluded-companies")
  .description("List globally excluded companies")
  .action(() => {
    const pipeline = new CareerOpsPipeline(rootDir, dbPath);
    try {
      const exclusions = pipeline.listExcludedCompanies();
      if (exclusions.length === 0) {
        console.log("No excluded companies configured.");
        return;
      }
      for (const exclusion of exclusions) {
        console.log(`#${exclusion.id} | ${exclusion.company} | key=${exclusion.companyKey}${exclusion.reason ? ` | reason=${exclusion.reason}` : ""}`);
      }
    } finally {
      pipeline.dispose();
    }
  });

program
  .command("remember-answer")
  .description("Store or update reusable application-answer memory")
  .argument("<questionKey>")
  .argument("<answer...>")
  .option("--tags <csv>", "optional comma-separated tags (metadata only)")
  .action((questionKey: string, answerParts: string[], options: { tags?: string }) => {
    const pipeline = new CareerOpsPipeline(rootDir, dbPath);
    try {
      const answer = answerParts.join(" ").trim();
      const tags = parseTagsCsv(options.tags);
      const id = pipeline.rememberApplicationAnswer(questionKey, answer, tags);
      console.log(`Saved answer memory #${id} for key "${questionKey.trim().toLowerCase()}".`);
    } finally {
      pipeline.dispose();
    }
  });

program
  .command("forget-answer")
  .description("Delete a reusable application-answer memory key")
  .argument("<questionKey>")
  .action((questionKey: string) => {
    const pipeline = new CareerOpsPipeline(rootDir, dbPath);
    try {
      const removed = pipeline.forgetApplicationAnswer(questionKey);
      console.log(removed
        ? `Removed answer memory key: ${questionKey.trim().toLowerCase()}`
        : `No answer memory key found for: ${questionKey.trim().toLowerCase()}`);
    } finally {
      pipeline.dispose();
    }
  });

program
  .command("list-answer-memory")
  .description("List reusable application-answer memory entries")
  .action(() => {
    const pipeline = new CareerOpsPipeline(rootDir, dbPath);
    try {
      const entries = pipeline.listApplicationAnswerMemory();
      if (entries.length === 0) {
        console.log("No answer memory entries saved.");
        return;
      }
      for (const entry of entries) {
        const tags = entry.tags.length > 0 ? entry.tags.join(",") : "-";
        console.log(`#${entry.id} | ${entry.questionKey} | used=${entry.usageCount} | tags=${tags}`);
        console.log(`  ${entry.answer}`);
      }
    } finally {
      pipeline.dispose();
    }
  });

program
  .command("resume-feedback")
  .description("Record performance feedback for a generated resume variant")
  .argument("<jobId>")
  .requiredOption("--outcome <outcome>", `one of: ${RESUME_FEEDBACK_OUTCOMES.join(", ")}`)
  .option("--score <score>", "optional numeric score (for example 3.5)")
  .option("--notes <notes>", "optional free-text notes")
  .action(async (jobId: string, options: { outcome: string; score?: string; notes?: string }) => {
    const pipeline = new CareerOpsPipeline(rootDir, dbPath);
    try {
      const parsedJobId = Number(jobId);
      if (!Number.isInteger(parsedJobId) || parsedJobId <= 0) {
        throw new Error(`Invalid job id ${jobId}. Expected a positive integer.`);
      }
      const outcome = validateResumeFeedbackOutcome(options.outcome);
      const score = options.score == null
        ? undefined
        : Number(options.score);
      if (score != null && !Number.isFinite(score)) {
        throw new Error(`Invalid --score value ${options.score}. Expected a number.`);
      }

      await pipeline.recordResumeVariantFeedback(parsedJobId, {
        outcome,
        score,
        notes: options.notes
      });
      console.log(`Saved resume feedback for job #${parsedJobId}: outcome=${outcome}${score != null ? ` score=${score}` : ""}`);
    } finally {
      pipeline.dispose();
    }
  });

program
  .command("resume-feedback-list")
  .description("List recorded resume-variant feedback entries")
  .option("--limit <count>", "max entries to print", "50")
  .action((options: { limit: string }) => {
    const pipeline = new CareerOpsPipeline(rootDir, dbPath);
    try {
      const limit = Number(options.limit);
      const entries = pipeline.listResumeVariantFeedback(Number.isFinite(limit) ? limit : 50);
      if (entries.length === 0) {
        console.log("No resume feedback entries found.");
        return;
      }
      for (const entry of entries) {
        const scoreText = entry.score != null ? entry.score.toFixed(2) : "-";
        const keywords = entry.resumeKeywords.slice(0, 6).join(", ");
        console.log(`#${entry.id} | job=${entry.jobId} | ${entry.company} | ${entry.title} | outcome=${entry.outcome} | score=${scoreText}`);
        if (keywords.length > 0) {
          console.log(`  keywords: ${keywords}`);
        }
        if (entry.notes != null && entry.notes.trim().length > 0) {
          console.log(`  notes: ${entry.notes.trim()}`);
        }
      }
    } finally {
      pipeline.dispose();
    }
  });

program
  .command("resume-feedback-summary")
  .description("Print aggregate performance feedback for resume variants")
  .action(() => {
    const pipeline = new CareerOpsPipeline(rootDir, dbPath);
    try {
      const summary = pipeline.summarizeResumeVariantFeedback();
      console.log(JSON.stringify(summary, null, 2));
    } finally {
      pipeline.dispose();
    }
  });

program
  .command("register-source")
  .description("Register a discovery source URL for daily sync")
  .argument("<url>")
  .option("--kind <kind>", "source kind", "generic")
  .option("--name <name>", "display name")
  .option("--region <regionId>", "region id", "toronto-canada")
  .option("--persistent", "use persistent browser profile for sync")
  .action((url: string, options: { kind: string; name?: string; region: string; persistent?: boolean }) => {
    const pipeline = new CareerOpsPipeline(rootDir, dbPath);
    try {
      const kind = validateSourceKind(options.kind);
      const source: CareerSource = {
        name: options.name ?? `${kind} ${options.region}`,
        sourceUrl: url,
        kind,
        regionId: options.region,
        active: true,
        usePersistentBrowser: options.persistent ?? false,
        metadata: { discoveryOnly: kind === "linkedin" || kind === "levels" }
      };
      const id = pipeline.registerSource(source);
      console.log(`Registered source ${id}: ${url}`);
    } finally {
      pipeline.dispose();
    }
  });

program
  .command("list-sources")
  .description("List registered discovery sources")
  .option("--all", "include inactive sources")
  .option("--region <regionId>", "filter by region id")
  .action((options: { all?: boolean; region?: string }) => {
    const pipeline = new CareerOpsPipeline(rootDir, dbPath);
    try {
      const sources = pipeline.listSources({ activeOnly: !options.all, regionId: options.region });
      printSources(sources);
    } finally {
      pipeline.dispose();
    }
  });

program
  .command("seed-toronto-sources")
  .description("Seed default Toronto discovery sources (LinkedIn, Levels, and general boards)")
  .action(() => {
    const pipeline = new CareerOpsPipeline(rootDir, dbPath);
    try {
      const ids = pipeline.seedTorontoDiscoverySources();
      console.log(`Seeded ${ids.length} Toronto discovery sources: ${ids.join(", ")}`);
    } finally {
      pipeline.dispose();
    }
  });

program
  .command("sync-source")
  .description("Sync one registered discovery source by id")
  .argument("<sourceId>")
  .option("--evaluate", "evaluate newly normalized jobs after sync")
  .option("--skip-evaluate", "skip evaluation after sync (overrides --evaluate)")
  .action(async (sourceId: string, options: { evaluate?: boolean; skipEvaluate?: boolean }) => {
    const pipeline = new CareerOpsPipeline(rootDir, dbPath);
    try {
      const parsedSourceId = Number(sourceId);
      if (!Number.isInteger(parsedSourceId) || parsedSourceId <= 0) {
        throw new Error(`Invalid source id ${sourceId}. Expected a positive integer.`);
      }
      const source = pipeline.listSources({ activeOnly: false }).find((entry) => entry.id === parsedSourceId);
      if (source == null) {
        throw new Error(`No source found for id ${parsedSourceId}.`);
      }
      console.log(`Syncing source #${source.id} (${source.kind}) ${source.name}`);
      const run = await syncOneSource(pipeline, source);
      printSourceRuns([run]);
      if (shouldEvaluateAfterSync(options)) {
        const summary = await pipeline.evaluatePending(250);
        console.log(JSON.stringify(summary, null, 2));
      }
    } finally {
      pipeline.dispose();
    }
  });

program
  .command("sync-sources")
  .description("Sync registered discovery sources into the local jobs database")
  .option("--region <regionId>", "filter registered sources by region", "toronto-canada")
  .option("--concurrency <count>", "parallel workers", "3")
  .option("--evaluate", "evaluate newly normalized jobs after sync")
  .option("--skip-evaluate", "skip evaluation after sync (overrides --evaluate)")
  .option("--limit <count>", "max sources to sync", "0")
  .action(async (options: { region: string; concurrency: string; evaluate?: boolean; skipEvaluate?: boolean; limit: string }) => {
    const pipeline = new CareerOpsPipeline(rootDir, dbPath);
    try {
      const sources = pipeline.listSources({ activeOnly: true, regionId: options.region });
      const selectedSources = Number(options.limit) > 0 ? sources.slice(0, Number(options.limit)) : sources;
      console.log(`Syncing ${selectedSources.length} sources (region=${options.region}, concurrency=${options.concurrency})`);
      const results = await syncSelectedSources(
        pipeline,
        selectedSources,
        Number(options.concurrency),
        (run) => printSourceRuns([run])
      );
      if (shouldEvaluateAfterSync(options)) {
        const summary = await pipeline.evaluatePending(250);
        console.log(JSON.stringify(summary, null, 2));
      }
      if (results.length === 0) {
        console.log("No active sources found for the selected region.");
      }
    } finally {
      pipeline.dispose();
    }
  });

program
  .command("sync-daily")
  .description("Alias for daily registered-source sync")
  .option("--region <regionId>", "filter registered sources by region", "toronto-canada")
  .option("--concurrency <count>", "parallel workers", "3")
  .option("--evaluate", "evaluate newly normalized jobs after sync")
  .option("--skip-evaluate", "skip evaluation after sync (overrides --evaluate)")
  .option("--limit <count>", "max sources to sync", "0")
  .action(async (options: { region: string; concurrency: string; evaluate?: boolean; skipEvaluate?: boolean; limit: string }) => {
    const pipeline = new CareerOpsPipeline(rootDir, dbPath);
    try {
      const sources = pipeline.listSources({ activeOnly: true, regionId: options.region });
      const selectedSources = Number(options.limit) > 0 ? sources.slice(0, Number(options.limit)) : sources;
      console.log(`Syncing ${selectedSources.length} sources (region=${options.region}, concurrency=${options.concurrency})`);
      const results = await syncSelectedSources(
        pipeline,
        selectedSources,
        Number(options.concurrency),
        (run) => printSourceRuns([run])
      );
      if (shouldEvaluateAfterSync(options)) {
        const summary = await pipeline.evaluatePending(250);
        console.log(JSON.stringify(summary, null, 2));
      }
      if (results.length === 0) {
        console.log("No active sources found for the selected region.");
      }
    } finally {
      pipeline.dispose();
    }
  });

program
  .command("scan")
  .description("Scan a careers page or direct listing URL")
  .argument("<url>")
  .action(async (url: string) => {
    const pipeline = new CareerOpsPipeline(rootDir, dbPath);
    try {
      const html = await fetchPageHtml(url);
      const summary = await pipeline.scanSource(url, html);
      console.log(JSON.stringify(summary, null, 2));
    } finally {
      pipeline.dispose();
    }
  });

program
  .command("auto-pipeline")
  .description("Run scan, evaluation, resume generation, and optional apply draft for one URL")
  .argument("<url>")
  .action(async (url: string) => {
    const pipeline = new CareerOpsPipeline(rootDir, dbPath);
    try {
      const html = await fetchPageHtml(url);
      const result = await pipeline.runAutoPipeline(url, html);
      console.log(JSON.stringify(result, null, 2));
    } finally {
      pipeline.dispose();
    }
  });

program
  .command("pipeline")
  .description("Run auto-pipeline sequentially for a file of URLs")
  .argument("<file>")
  .action(async (file: string) => {
    const pipeline = new CareerOpsPipeline(rootDir, dbPath);
    try {
      const urls = readUrlsFromFile(file);
      const results = [] as Array<{ url: string; jobIds: number[]; evaluations: number; resumes: string[]; drafts: number; rejected: number }>;
      for (const url of urls) {
        const html = await fetchPageHtml(url);
        results.push({ url, ...(await pipeline.runAutoPipeline(url, html)) });
      }
      console.log(JSON.stringify(results, null, 2));
    } finally {
      pipeline.dispose();
    }
  });

program
  .command("batch")
  .description("Run auto-pipeline concurrently for a file of URLs")
  .argument("<file>")
  .option("--concurrency <count>", "parallel workers", "4")
  .action(async (file: string, { concurrency }: { concurrency: string }) => {
    const pipeline = new CareerOpsPipeline(rootDir, dbPath);
    const queue = new PQueue({ concurrency: Number(concurrency) });
    try {
      const urls = readUrlsFromFile(file);
      const results = await Promise.all(urls.map((url) => queue.add(async () => {
        const html = await fetchPageHtml(url);
        return { url, ...(await pipeline.runAutoPipeline(url, html)) };
      })));
      console.log(JSON.stringify(results, null, 2));
    } finally {
      pipeline.dispose();
    }
  });

program
  .command("evaluate")
  .description("Evaluate pending jobs")
  .option("--limit <count>", "max pending jobs", "25")
  .action(async ({ limit }: { limit: string }) => {
    const pipeline = new CareerOpsPipeline(rootDir, dbPath);
    try {
      const summary = await pipeline.evaluatePending(Number(limit));
      console.log(JSON.stringify(summary, null, 2));
    } finally {
      pipeline.dispose();
    }
  });

program
  .command("evaluate-batch")
  .description("Evaluate pending jobs with bounded parallelism")
  .option("--limit <count>", "max pending jobs", "122")
  .option("--concurrency <count>", "parallel evaluator workers", "6")
  .action(async ({ limit, concurrency }: { limit: string; concurrency: string }) => {
    const pipeline = new CareerOpsPipeline(rootDir, dbPath);
    const queue = new PQueue({ concurrency: Number(concurrency) });
    try {
      const jobs = pipeline.repo.listJobsByStatus(["normalized"]).slice(0, Number(limit));
      await Promise.all(jobs.map((record: JobRecordWithArtifacts) => queue.add(async () => {
        await pipeline.evaluateJob(record.job.id);
      })));
      console.log(`Processed ${jobs.length} jobs with concurrency ${concurrency}`);
    } finally {
      pipeline.dispose();
    }
  });

program
  .command("oferta")
  .description("Show a rich single-offer evaluation report")
  .argument("<jobId>")
  .action(async (jobId: string) => {
    const pipeline = new CareerOpsPipeline(rootDir, dbPath);
    try {
      const report = await pipeline.generateOfferReport(Number(jobId));
      printEvaluationReport(report);
    } finally {
      pipeline.dispose();
    }
  });

program
  .command("ofertas")
  .description("Compare multiple offers by score, grade, and risk")
  .argument("<jobIds...>")
  .action(async (jobIds: string[]) => {
    const pipeline = new CareerOpsPipeline(rootDir, dbPath);
    try {
      const comparison = await pipeline.compareOffers(jobIds.map((jobId) => Number(jobId)));
      console.log(comparison.summary);
      for (const row of comparison.ranking) {
        console.log(`- #${row.jobId} ${row.company} | ${row.title} | ${row.totalScore.toFixed(2)} | ${row.grade} | ${row.recommendedAction} | ${row.mainRisk}`);
      }
    } finally {
      pipeline.dispose();
    }
  });

program
  .command("resume")
  .description("Generate a tailored resume artifact path for a job")
  .argument("<jobId>")
  .action(async (jobId: string) => {
    const pipeline = new CareerOpsPipeline(rootDir, dbPath);
    try {
      const outputPath = await pipeline.generateResume(Number(jobId));
      console.log(outputPath);
    } finally {
      pipeline.dispose();
    }
  });

program
  .command("pdf")
  .description("Alias for resume generation")
  .argument("<jobId>")
  .action(async (jobId: string) => {
    const pipeline = new CareerOpsPipeline(rootDir, dbPath);
    try {
      const outputPath = await pipeline.generateResume(Number(jobId));
      console.log(outputPath);
    } finally {
      pipeline.dispose();
    }
  });

program
  .command("deep")
  .description("Generate deep company research for a job")
  .argument("<jobId>")
  .action(async (jobId: string) => {
    const pipeline = new CareerOpsPipeline(rootDir, dbPath);
    try {
      const report = await pipeline.researchCompany(Number(jobId));
      console.log(JSON.stringify(report, null, 2));
    } finally {
      pipeline.dispose();
    }
  });

program
  .command("contact")
  .description("Generate an outreach draft for a job")
  .argument("<jobId>")
  .action(async (jobId: string) => {
    const pipeline = new CareerOpsPipeline(rootDir, dbPath);
    try {
      const draft = await pipeline.draftContact(Number(jobId));
      console.log(draft.subject);
      console.log("---");
      console.log(draft.message);
    } finally {
      pipeline.dispose();
    }
  });

program
  .command("contacto")
  .description("Alias for contact")
  .argument("<jobId>")
  .action(async (jobId: string) => {
    const pipeline = new CareerOpsPipeline(rootDir, dbPath);
    try {
      const draft = await pipeline.draftContact(Number(jobId));
      console.log(draft.subject);
      console.log("---");
      console.log(draft.message);
    } finally {
      pipeline.dispose();
    }
  });

program
  .command("training")
  .description("Evaluate a course or certification against the target archetypes")
  .argument("<source...>")
  .action(async (sourceParts: string[]) => {
    const pipeline = new CareerOpsPipeline(rootDir, dbPath);
    try {
      const source = readSourceInput(sourceParts.join(" "));
      const assessment = await pipeline.assessTraining(source);
      console.log(JSON.stringify(assessment, null, 2));
    } finally {
      pipeline.dispose();
    }
  });

program
  .command("tracker")
  .description("Print tracker counts and top opportunities")
  .action(() => {
    const pipeline = new CareerOpsPipeline(rootDir, dbPath);
    try {
      printTracker(pipeline.repo.listJobs());
    } finally {
      pipeline.dispose();
    }
  });

program
  .command("draft-apply")
  .description("Create a prefilled application draft for review")
  .argument("<jobId>")
  .action(async (jobId: string) => {
    const pipeline = new CareerOpsPipeline(rootDir, dbPath);
    try {
      await pipeline.draftApplication(Number(jobId));
      console.log(`Drafted application for ${jobId}`);
    } finally {
      pipeline.dispose();
    }
  });

program
  .command("autoapply-shortlist")
  .description("Bulk prefill shortlisted jobs in Playwright with uploaded resume and profile answers")
  .option("--resume <path>", `resume file path (defaults to ${AUTOAPPLY_ENV_RESUME})`)
  .option("--info <path>", `optional JSON file with additional answer key/value pairs (defaults to ${AUTOAPPLY_ENV_INFO})`)
  .option("--submit", `attempt to submit forms automatically (can also use ${AUTOAPPLY_ENV_SUBMIT}=1)`)
  .option("--headless", "run browser in headless mode")
  .option("--wait-ms <ms>", "settle delay after page load before filling", String(AUTOAPPLY_DEFAULT_WAIT_MS))
  .option("--limit <count>", "max shortlisted jobs to process", "0")
  .action(async (options: { resume?: string; info?: string; submit?: boolean; headless?: boolean; waitMs?: string; limit?: string }) => {
    const parsed = parseAutoApplyOptions(options);
    const summary = await runShortlistAutoApply(parsed);
    if (summary.processed === 0) {
      console.log("No shortlisted jobs found in statuses: shortlisted, resume_ready, ready_to_apply, in_review.");
      return;
    }
    console.log(JSON.stringify(summary, null, 2));
  });

async function runInteractiveApply(jobId: number): Promise<void> {
  const pipeline = new CareerOpsPipeline(rootDir, dbPath);
  try {
    const record = pipeline.repo.getJobRecord(jobId);
    if (record.resume == null) {
      await pipeline.generateResume(jobId);
    }
    const refreshedRecord = pipeline.repo.getJobRecord(jobId);
    if (refreshedRecord.application == null) {
      await pipeline.draftApplication(jobId);
    }
    const refreshed = pipeline.repo.getJobRecord(jobId);
    if (refreshed.job.status === "ready_to_apply") {
      pipeline.repo.updateJobStatus(jobId, "in_review");
    }
    if (refreshed.application == null) {
      throw new Error("Application draft was not created.");
    }
    ensureReviewRequired(refreshed.application);
    mkdirSync(browserProfileDir, { recursive: true });
    const context = await chromium.launchPersistentContext(browserProfileDir, {
      channel: "chrome",
      headless: false
    });
    const page = await context.newPage();
    await page.goto(refreshed.application.targetUrl, { waitUntil: "domcontentloaded" });
    await fillCommonFields(page, refreshed.application);
    console.log("Application prefill complete. Review in the browser and submit manually if desired.");
    console.log("Submission is intentionally blocked by default in this command.");
    await page.pause();
    await context.close();
  } finally {
    pipeline.dispose();
  }
}

program
  .command("review-apply")
  .description("Open a headed browser session and prefill known answers without submitting")
  .argument("<jobId>")
  .action(async (jobId: string) => {
    await runInteractiveApply(Number(jobId));
  });

program
  .command("apply")
  .description("Alias for headed human-in-the-loop application review")
  .argument("<jobId>")
  .action(async (jobId: string) => {
    await runInteractiveApply(Number(jobId));
  });

void program.parseAsync(process.argv);
