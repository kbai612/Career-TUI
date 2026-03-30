import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import OpenAI from "openai";
import { chromium, type BrowserContext, type Frame, type Locator, type Page } from "playwright";
import { Command } from "commander";
import PQueue from "p-queue";
import { ImapFlow } from "imapflow";
import Tesseract = require("tesseract.js");
import { normalizeLevelsSourceUrl, normalizeLinkedInSourceUrl } from "./source-url";
import {
  pickBestLinkedInEntryCandidate,
  extractOtpCodeFromText,
  extractVerificationUrlFromText,
  isAutofillTrapText,
  normalizeAutoApplyMode,
  resolveLinkedInJobPostingUrl,
  splitName,
  type AutoApplyMode,
  type LinkedInEntryCandidateSample,
  type LinkedInEntryKind
} from "./autoapply-utils";
import {
  canTransition,
  CareerOpsPipeline,
  RESUME_FEEDBACK_OUTCOMES,
  SOURCE_KINDS,
  ensureDataPaths,
  ensureReviewRequired,
  loadProfilePack,
  loadRootEnv,
  resolveLlmRuntimeConfig,
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
const execFileAsync = promisify(execFile);
const program = new Command();
const TESSERACT_CACHE_DIR = path.resolve(rootDir, "data", "tesseract-cache");
const DEFAULT_HTTP_HEADERS = {
  "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36",
  "accept-language": "en-US,en;q=0.9"
};
const LINKEDIN_FETCH_TIMEOUT_MS = Number(process.env.CAREER_OPS_LINKEDIN_FETCH_TIMEOUT_MS ?? 20000);
const LINKEDIN_GUEST_MAX_ATTEMPTS = Number(process.env.CAREER_OPS_LINKEDIN_GUEST_MAX_ATTEMPTS ?? 3);
const LINKEDIN_GUEST_RETRY_BASE_MS = Number(process.env.CAREER_OPS_LINKEDIN_GUEST_RETRY_BASE_MS ?? 1250);
const LINKEDIN_GUEST_PAGE_DELAY_MS = Number(process.env.CAREER_OPS_LINKEDIN_GUEST_PAGE_DELAY_MS ?? 300);
const LINKEDIN_GUEST_PAGE_SIZE = process.env.CAREER_OPS_LINKEDIN_GUEST_PAGE_SIZE == null
  ? undefined
  : Number(process.env.CAREER_OPS_LINKEDIN_GUEST_PAGE_SIZE);
const LINKEDIN_GUEST_MAX_PAGES = Number(process.env.CAREER_OPS_LINKEDIN_GUEST_MAX_PAGES ?? 40);
const LINKEDIN_EXTERNAL_RESOLVE_LIMIT = Number(process.env.CAREER_OPS_LINKEDIN_EXTERNAL_RESOLVE_LIMIT ?? 25);
const LINKEDIN_JOB_DETAIL_MAX_ATTEMPTS = Number(process.env.CAREER_OPS_LINKEDIN_JOB_DETAIL_MAX_ATTEMPTS ?? 2);
const LINKEDIN_JOB_DETAIL_RETRY_BASE_MS = Number(process.env.CAREER_OPS_LINKEDIN_JOB_DETAIL_RETRY_BASE_MS ?? 500);
const SOURCE_API_FETCH_TIMEOUT_MS = Number(process.env.CAREER_OPS_SOURCE_API_FETCH_TIMEOUT_MS ?? 20000);
const SOURCE_SYNC_TIMEOUT_MS = Number(process.env.CAREER_OPS_SOURCE_SYNC_TIMEOUT_MS ?? 120000);
const AUTOAPPLY_AI_ANSWER_MAX_OPTIONS = 12;
const AUTOAPPLY_AI_ANSWER_CACHE = new Map<string, string | null>();
const PERSISTENT_FETCH_QUEUE = new PQueue({ concurrency: 1 });
let autoApplyAnswerClient: OpenAI | null | undefined;
let autoApplyAnswerModel: string | null | undefined;
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
const KNOWN_ATS_HOST_PATTERNS = [
  /(^|\.)greenhouse\.io$/i,
  /(^|\.)lever\.co$/i,
  /(^|\.)ashbyhq\.com$/i,
  /(^|\.)smartrecruiters\.com$/i,
  /(^|\.)icims\.com$/i,
  /(^|\.)jobvite\.com$/i,
  /(^|\.)workable\.com$/i,
  /(^|\.)recruitee\.com$/i,
  /(^|\.)bamboohr\.com$/i,
  /(^|\.)applytojob\.com$/i,
  /(^|\.)oraclecloud\.com$/i,
  /(^|\.)taleo\.net$/i,
  /(^|\.)successfactors\.com$/i
];
const WORKDAY_HOST_PATTERNS = [
  /(^|\.)myworkdayjobs\.com$/i,
  /(^|\.)myworkdaysite\.com$/i,
  /(^|\.)wd\d+\.myworkdayjobs\.com$/i,
  /(^|\.)workday\.com$/i
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
  const configuredGuestPageSize = typeof LINKEDIN_GUEST_PAGE_SIZE === "number"
    && Number.isFinite(LINKEDIN_GUEST_PAGE_SIZE)
    && LINKEDIN_GUEST_PAGE_SIZE > 0
    ? Math.floor(LINKEDIN_GUEST_PAGE_SIZE)
    : undefined;
  const guestMaxPages = Number.isFinite(LINKEDIN_GUEST_MAX_PAGES) && LINKEDIN_GUEST_MAX_PAGES > 0
    ? Math.floor(LINKEDIN_GUEST_MAX_PAGES)
    : 40;
  let remainingResolveBudget = Math.max(0, LINKEDIN_EXTERNAL_RESOLVE_LIMIT);
  const seenJobViewUrls = new Set<string>();
  let inferredGuestPageSize: number | undefined;
  let start = 0;
  for (let pageIndex = 0; pageIndex < guestMaxPages; pageIndex += 1) {
    guestUrl.searchParams.set("start", String(start));
    const html = await fetchLinkedInGuestPageHtml(guestUrl);
    if (!containsLinkedInSearchCards(html)) {
      break;
    }

    const pageJobViewUrls = extractLinkedInJobViewUrlsFromGuestHtml(html);
    if (pageJobViewUrls.length === 0) {
      break;
    }
    if (inferredGuestPageSize == null) {
      inferredGuestPageSize = pageJobViewUrls.length;
    }
    const newJobViewUrls = pageJobViewUrls.filter((jobUrl) => {
      if (seenJobViewUrls.has(jobUrl)) {
        return false;
      }
      seenJobViewUrls.add(jobUrl);
      return true;
    });
    if (newJobViewUrls.length === 0) {
      break;
    }

    const jobViewUrlsToResolve = remainingResolveBudget > 0
      ? newJobViewUrls.slice(0, remainingResolveBudget)
      : [];
    remainingResolveBudget -= jobViewUrlsToResolve.length;
    const resolvedJobDetails = await resolveLinkedInJobDetails(jobViewUrlsToResolve);
    const rewrittenHtml = rewriteLinkedInGuestCardLinks(html, resolvedJobDetails);
    pages.push(rewrittenHtml);

    const pageAdvance = configuredGuestPageSize ?? inferredGuestPageSize ?? 10;
    start += Math.max(1, pageAdvance);
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
const AUTOAPPLY_DEFAULT_OTP_TIMEOUT_MS = 120000;
const AUTOAPPLY_DEFAULT_OTP_POLL_MS = 4000;
const AUTOAPPLY_ENV_RESUME = "CAREER_OPS_UPLOADED_RESUME";
const AUTOAPPLY_ENV_INFO = "CAREER_OPS_AUTOAPPLY_INFO_JSON";
const AUTOAPPLY_ENV_SUBMIT = "CAREER_OPS_AUTOAPPLY_SUBMIT";
const AUTOAPPLY_ENV_MODE = "CAREER_OPS_AUTOAPPLY_MODE";
const AUTOAPPLY_ENV_OS_DRY_RUN = "CAREER_OPS_AUTOAPPLY_OS_DRY_RUN";
const AUTOAPPLY_ENV_LOGIN_EMAIL = "CAREER_OPS_AUTOAPPLY_LOGIN_EMAIL";
const AUTOAPPLY_ENV_LOGIN_PASSWORD = "CAREER_OPS_AUTOAPPLY_LOGIN_PASSWORD";
const AUTOAPPLY_ENV_LOGIN_FIRST_NAME = "CAREER_OPS_AUTOAPPLY_LOGIN_FIRST_NAME";
const AUTOAPPLY_ENV_LOGIN_LAST_NAME = "CAREER_OPS_AUTOAPPLY_LOGIN_LAST_NAME";
const AUTOAPPLY_ENV_ALLOW_CREATE_ACCOUNT = "CAREER_OPS_AUTOAPPLY_ALLOW_CREATE_ACCOUNT";
const AUTOAPPLY_ENV_OTP_HOST = "CAREER_OPS_AUTOAPPLY_OTP_IMAP_HOST";
const AUTOAPPLY_ENV_OTP_PORT = "CAREER_OPS_AUTOAPPLY_OTP_IMAP_PORT";
const AUTOAPPLY_ENV_OTP_SECURE = "CAREER_OPS_AUTOAPPLY_OTP_IMAP_SECURE";
const AUTOAPPLY_ENV_OTP_USER = "CAREER_OPS_AUTOAPPLY_OTP_IMAP_USER";
const AUTOAPPLY_ENV_OTP_PASSWORD = "CAREER_OPS_AUTOAPPLY_OTP_IMAP_PASSWORD";
const AUTOAPPLY_ENV_OTP_MAILBOX = "CAREER_OPS_AUTOAPPLY_OTP_IMAP_MAILBOX";
const AUTOAPPLY_ENV_OTP_TIMEOUT_MS = "CAREER_OPS_AUTOAPPLY_OTP_TIMEOUT_MS";
const AUTOAPPLY_ENV_OTP_POLL_MS = "CAREER_OPS_AUTOAPPLY_OTP_POLL_MS";
const AUTOAPPLY_ENV_PYTHON = "CAREER_OPS_AUTOAPPLY_PYTHON";
const PYAUTOGUI_BRIDGE_PATH = path.resolve(rootDir, "apps", "worker", "src", "pyautogui_bridge.py");

interface AutoApplyLoginProfile {
  email: string;
  password: string;
  firstName: string;
  lastName: string;
  allowCreateAccount: boolean;
}

interface AutoApplyOtpSettings {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  password: string;
  mailbox: string;
  timeoutMs: number;
  pollMs: number;
}

type EmailVerificationAction =
  | {
      kind: "otp";
      value: string;
    }
  | {
      kind: "link";
      value: string;
    };

interface OsInputAction {
  kind: "move" | "click" | "type" | "keys";
  detail: string;
}

interface AutoApplyIdentity {
  fullName: string;
  email: string;
  firstName: string;
  lastName: string;
  phone: string;
  location: string;
  linkedin: string;
  github: string;
  portfolio: string;
}

interface VisibleStepField {
  locator: Locator;
  prompt: string;
  tag: string;
  type: string;
  required: boolean;
  optionLabels: string[];
  currentValue: string;
  empty: boolean;
}

interface VisibleStepFillResult {
  filledPrompts: string[];
  unresolvedRequiredPrompts: string[];
}

interface VisibleChoiceGroup {
  fieldset: Locator;
  prompt: string;
  required: boolean;
  optionLabels: string[];
  type: "checkbox" | "radio";
}

type FillContext = Page | Frame;

interface FillContextRef {
  context: FillContext;
  allowOsInput: boolean;
}

type ApplyEntryRoute =
  | "direct_form"
  | "linkedin_easy_apply"
  | "linkedin_apply"
  | "workday"
  | "company_specific"
  | "generic_apply";

interface ApplicationEntryResult {
  page: Page;
  route: ApplyEntryRoute;
}

interface AutoApplyJobResult {
  jobId: number;
  company: string;
  title: string;
  targetUrl: string;
  outcome: "prefilled" | "submitted" | "failed";
  entryRoute?: ApplyEntryRoute;
  resumeUploaded: boolean;
  roleAnswersUsed: number;
  missingKeys: string[];
  loginAttempted?: boolean;
  accountCreated?: boolean;
  otpCodeUsed?: boolean;
  osInputActions?: OsInputAction[];
  debugArtifactsDir?: string;
  pageErrors?: string[];
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
  mode: AutoApplyMode;
  osDryRun: boolean;
  loginProfile: AutoApplyLoginProfile | null;
  otpSettings: AutoApplyOtpSettings | null;
}

interface AutoApplySingleRunOptions extends AutoApplyOptions {
  jobId?: number;
  targetUrl?: string;
  debugArtifacts: boolean;
  debugDir?: string;
}

interface AutoApplyDebugSnapshot {
  step: number;
  label: string;
  timestamp: string;
  url: string;
  screenshotFile: string;
  stateFile: string;
  htmlFile: string;
}

interface AutoApplyDebugSession {
  runDir: string;
  stepCounter: number;
  snapshots: AutoApplyDebugSnapshot[];
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
  work_authorization: ["work authorization", "authorized to work", "legally authorized", "eligible to work"],
  salary_expectation: ["salary", "compensation", "salary expectation", "desired salary", "expected salary"],
  notice_period: ["notice period", "start date", "available to start", "when can you start", "availability"],
  cover_letter: ["cover letter", "why are you interested", "why do you want", "motivation", "tell us about yourself"],
  race: ["race", "ethnicity"],
  gender: ["gender", "sex"],
  veteran: ["veteran", "protected veteran"],
  disability: ["disability", "disabled"],
  hear_about_role: ["how did you hear", "how did you find", "source", "referral source"]
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

function parsePositiveNumber(value: string | undefined, fallback: number): number {
  if (value == null || value.trim().length === 0) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

function parseBooleanOption(value: string | undefined, fallback: boolean): boolean {
  if (value == null || value.trim().length === 0) {
    return fallback;
  }
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "n", "off"].includes(normalized)) {
    return false;
  }
  return fallback;
}

function parseAutoApplyMode(value: string | undefined): AutoApplyMode {
  return normalizeAutoApplyMode(value);
}

function resolveAutoApplyIdentity(): AutoApplyIdentity {
  const profile = loadProfilePack(rootDir);
  const nameParts = splitName(profile.name);
  return {
    fullName: profile.name,
    email: profile.email,
    firstName: nameParts.firstName,
    lastName: nameParts.lastName,
    phone: profile.phone,
    location: profile.location,
    linkedin: profile.linkedin ?? "",
    github: profile.github ?? "",
    portfolio: profile.portfolio ?? ""
  };
}

function resolveLoginProfile(
  identity: AutoApplyIdentity,
  raw: {
    loginEmail?: string;
    loginPassword?: string;
    loginFirstName?: string;
    loginLastName?: string;
    allowCreateAccount?: boolean;
  }
): AutoApplyLoginProfile | null {
  const loginEmail = raw.loginEmail?.trim().length
    ? raw.loginEmail.trim()
    : process.env[AUTOAPPLY_ENV_LOGIN_EMAIL]?.trim() || identity.email;
  const loginPassword = raw.loginPassword?.trim().length
    ? raw.loginPassword.trim()
    : process.env[AUTOAPPLY_ENV_LOGIN_PASSWORD]?.trim();

  if (!loginEmail || !loginPassword) {
    return null;
  }

  const firstName = raw.loginFirstName?.trim().length
    ? raw.loginFirstName.trim()
    : process.env[AUTOAPPLY_ENV_LOGIN_FIRST_NAME]?.trim() || identity.firstName;
  const lastName = raw.loginLastName?.trim().length
    ? raw.loginLastName.trim()
    : process.env[AUTOAPPLY_ENV_LOGIN_LAST_NAME]?.trim() || identity.lastName;

  const allowCreateAccount = raw.allowCreateAccount === true
    || parseBooleanOption(process.env[AUTOAPPLY_ENV_ALLOW_CREATE_ACCOUNT], false);

  return {
    email: loginEmail,
    password: loginPassword,
    firstName,
    lastName,
    allowCreateAccount
  };
}

function resolveOtpSettings(raw: {
  otpHost?: string;
  otpPort?: string;
  otpSecure?: string;
  otpUser?: string;
  otpPassword?: string;
  otpMailbox?: string;
  otpTimeoutMs?: string;
  otpPollMs?: string;
}): AutoApplyOtpSettings | null {
  const host = raw.otpHost?.trim().length
    ? raw.otpHost.trim()
    : process.env[AUTOAPPLY_ENV_OTP_HOST]?.trim();
  if (!host) {
    return null;
  }

  const user = raw.otpUser?.trim().length
    ? raw.otpUser.trim()
    : process.env[AUTOAPPLY_ENV_OTP_USER]?.trim();
  const password = raw.otpPassword?.trim().length
    ? raw.otpPassword.trim()
    : process.env[AUTOAPPLY_ENV_OTP_PASSWORD]?.trim();

  if (!user || !password) {
    throw new Error(
      `OTP email polling requires both ${AUTOAPPLY_ENV_OTP_USER} and ${AUTOAPPLY_ENV_OTP_PASSWORD} when host is configured.`
    );
  }

  const secure = parseBooleanOption(raw.otpSecure ?? process.env[AUTOAPPLY_ENV_OTP_SECURE], true);
  const defaultPort = secure ? 993 : 143;
  const port = parsePositiveNumber(raw.otpPort ?? process.env[AUTOAPPLY_ENV_OTP_PORT], defaultPort);
  const mailbox = raw.otpMailbox?.trim().length
    ? raw.otpMailbox.trim()
    : process.env[AUTOAPPLY_ENV_OTP_MAILBOX]?.trim() || "INBOX";
  const timeoutMs = parsePositiveNumber(raw.otpTimeoutMs ?? process.env[AUTOAPPLY_ENV_OTP_TIMEOUT_MS], AUTOAPPLY_DEFAULT_OTP_TIMEOUT_MS);
  const pollMs = parsePositiveNumber(raw.otpPollMs ?? process.env[AUTOAPPLY_ENV_OTP_POLL_MS], AUTOAPPLY_DEFAULT_OTP_POLL_MS);

  return {
    host,
    port,
    secure,
    user,
    password,
    mailbox,
    timeoutMs,
    pollMs
  };
}

function encodePowerShell(script: string): string {
  return Buffer.from(script, "utf16le").toString("base64");
}

async function runPowerShellScript(script: string): Promise<void> {
  const encodedScript = encodePowerShell(script);
  await execFileAsync("powershell", [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-EncodedCommand",
    encodedScript
  ], {
    windowsHide: true,
    maxBuffer: 1024 * 1024 * 4
  });
}

function quotePowerShellSingle(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

class WindowsOsInputDriver {
  readonly actions: OsInputAction[] = [];

  constructor(private readonly dryRun: boolean) {}

  private async run(args: string[], action: OsInputAction): Promise<void> {
    this.actions.push(action);
    if (this.dryRun) {
      return;
    }
    const pythonExecutable = (process.env[AUTOAPPLY_ENV_PYTHON] ?? "python").trim() || "python";
    try {
      await execFileAsync(pythonExecutable, [
        PYAUTOGUI_BRIDGE_PATH,
        ...args
      ], {
        windowsHide: true,
        maxBuffer: 1024 * 1024 * 4
      });
    } catch (error) {
      const stderr = error instanceof Error && "stderr" in error
        ? String((error as Error & { stderr?: string }).stderr ?? "").trim()
        : "";
      const message = stderr.length > 0
        ? stderr
        : error instanceof Error
          ? error.message
          : String(error);
      throw new Error(message);
    }
  }

  async moveAndClick(x: number, y: number): Promise<void> {
    const safeX = Math.round(x);
    const safeY = Math.round(y);
    await this.run([
      "click",
      "--x",
      String(safeX),
      "--y",
      String(safeY)
    ], {
      kind: "click",
      detail: `(${safeX}, ${safeY})`
    });
  }

  async clickViewportPoint(x: number, y: number, scale = 1): Promise<void> {
    await this.run([
      "click-viewport",
      "--x",
      String(Math.round(x)),
      "--y",
      String(Math.round(y)),
      "--scale",
      String(Math.max(0.5, scale))
    ], {
      kind: "click",
      detail: `viewport(${Math.round(x)}, ${Math.round(y)})@${scale.toFixed(2)}`
    });
  }

  async sendKeys(sequence: string): Promise<void> {
    await this.run([
      "send-keys",
      "--sequence",
      sequence
    ], {
      kind: "keys",
      detail: sequence
    });
  }

  async activateWindow(titleHint?: string): Promise<void> {
    await this.run([
      "activate-window",
      "--title-hint",
      (titleHint ?? "").trim()
    ], {
      kind: "keys",
      detail: `activate-window:${(titleHint ?? "Chrome").slice(0, 40)}`
    });
  }

  async typeText(value: string): Promise<void> {
    if (value.length === 0) {
      return;
    }
    await this.run([
      "type-text",
      "--text",
      value
    ], {
      kind: "type",
      detail: `${value.length} chars`
    });
  }
}

function isLinkedInUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return /(^|\.)linkedin\.com$/i.test(parsed.hostname);
  } catch {
    return /linkedin\.com/i.test(url);
  }
}

function isLeverUrl(url: string): boolean {
  const hostname = getUrlHostname(url);
  if (hostname.length === 0) {
    return /lever\.co/i.test(url);
  }
  return hostname === "jobs.lever.co"
    || hostname.endsWith(".jobs.lever.co")
    || /(^|\.)lever\.co$/i.test(hostname);
}

function getUrlHostname(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function isWorkdayUrl(url: string): boolean {
  const hostname = getUrlHostname(url);
  if (hostname.length === 0) {
    return /myworkday|workday/i.test(url);
  }
  if (WORKDAY_HOST_PATTERNS.some((pattern) => pattern.test(hostname))) {
    return true;
  }
  if (/myworkday/i.test(hostname)) {
    return true;
  }
  try {
    const parsed = new URL(url);
    const path = parsed.pathname.toLowerCase();
    if (/\/recruiting\/|\/job\//i.test(path) && /workday/i.test(hostname)) {
      return true;
    }
  } catch {
    // best effort URL parse only
  }
  return false;
}

function isKnownAtsUrl(url: string): boolean {
  const hostname = getUrlHostname(url);
  if (hostname.length === 0) {
    return false;
  }
  if (isWorkdayUrl(url) || isLinkedInUrl(url) || isLeverUrl(url)) {
    return false;
  }
  return KNOWN_ATS_HOST_PATTERNS.some((pattern) => pattern.test(hostname));
}

async function waitForPageSettle(page: Page): Promise<void> {
  await page.waitForLoadState("domcontentloaded", { timeout: 15000 }).catch(() => undefined);
  await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => undefined);
}

async function waitForLightSettle(page: Page): Promise<void> {
  await page.waitForLoadState("domcontentloaded", { timeout: 4000 }).catch(() => undefined);
  await page.waitForTimeout(900).catch(() => undefined);
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

function normalizePromptText(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function isAutofillTrapPrompt(value: string): boolean {
  return isAutofillTrapText(normalizePromptText(value));
}

function getAutoApplyAnswerClient(): { client: OpenAI; model: string } | null {
  if (autoApplyAnswerClient !== undefined && autoApplyAnswerModel !== undefined) {
    return autoApplyAnswerClient == null || autoApplyAnswerModel == null
      ? null
      : {
          client: autoApplyAnswerClient,
          model: autoApplyAnswerModel
        };
  }

  const runtimeConfig = resolveLlmRuntimeConfig();
  if (runtimeConfig.apiKey == null) {
    autoApplyAnswerClient = null;
    autoApplyAnswerModel = null;
    return null;
  }

  autoApplyAnswerClient = new OpenAI({
    apiKey: runtimeConfig.apiKey,
    baseURL: runtimeConfig.baseURL,
    defaultHeaders: runtimeConfig.defaultHeaders
  });
  autoApplyAnswerModel = runtimeConfig.model;
  return {
    client: autoApplyAnswerClient,
    model: autoApplyAnswerModel
  };
}

function phoneDigits(value: string): string {
  return value.replace(/\D/g, "");
}

function phoneCountryCode(value: string): string {
  const digits = phoneDigits(value);
  if (digits.length === 11 && digits.startsWith("1")) {
    return "+1";
  }
  if (digits.length > 10) {
    return `+${digits.slice(0, digits.length - 10)}`;
  }
  return digits.length > 0 ? `+${digits}` : "";
}

function phoneNationalNumber(value: string): string {
  const digits = phoneDigits(value);
  if (digits.length === 11 && digits.startsWith("1")) {
    return digits.slice(1);
  }
  return digits;
}

function locationCity(value: string): string {
  return value.split(",")[0]?.trim() ?? value.trim();
}

function locationCountry(value: string): string {
  const parts = value.split(",").map((entry) => entry.trim()).filter((entry) => entry.length > 0);
  return parts.at(-1) ?? value.trim();
}

function mergedAnswersMap(draft: ApplicationDraft, additionalAnswers: Record<string, string>): Record<string, string> {
  return {
    ...draft.answers,
    ...additionalAnswers
  };
}

function chooseBestAnswerKeyForPrompt(prompt: string, answerMap: Record<string, string>): string | null {
  const normalizedPrompt = normalizePromptText(prompt);
  let bestKey: string | null = null;
  let bestScore = 0;
  for (const key of Object.keys(answerMap)) {
    const value = String(answerMap[key] ?? "").trim();
    if (value.length === 0) {
      continue;
    }
    for (const token of resolveAnswerTokens(key)) {
      const normalizedToken = normalizePromptText(token);
      if (normalizedToken.length < 3) {
        continue;
      }
      let score = 0;
      if (normalizedPrompt === normalizedToken) {
        score = 100;
      } else if (normalizedPrompt.includes(normalizedToken)) {
        score = 80 + normalizedToken.length;
      } else if (normalizedToken.includes(normalizedPrompt) && normalizedPrompt.length >= 4) {
        score = 50 + normalizedPrompt.length;
      }
      if (score > bestScore) {
        bestKey = key;
        bestScore = score;
      }
    }
  }
  return bestKey;
}

function chooseOptionLabel(optionLabels: string[], targets: string[]): string | null {
  const normalizedOptions = optionLabels
    .map((label) => ({ label, normalized: normalizePromptText(label) }))
    .filter((entry) => entry.normalized.length > 0);
  for (const target of targets) {
    const normalizedTarget = normalizePromptText(target);
    const exact = normalizedOptions.find((entry) => entry.normalized === normalizedTarget);
    if (exact != null) {
      return exact.label;
    }
    const partial = normalizedOptions.find((entry) => entry.normalized.includes(normalizedTarget) || normalizedTarget.includes(entry.normalized));
    if (partial != null) {
      return partial.label;
    }
  }
  return null;
}

function coerceVisiblePromptAnswer(
  field: { tag: string; type: string; optionLabels: string[] },
  answer: string
): string | null {
  const trimmed = answer.trim();
  if (trimmed.length === 0) {
    return null;
  }
  if (field.optionLabels.length === 0) {
    return trimmed;
  }
  return chooseOptionLabel(field.optionLabels, [trimmed]) ?? null;
}

async function inferAnswerWithLlm(
  prompt: string,
  field: { tag: string; type: string; optionLabels: string[] },
  draft: ApplicationDraft,
  additionalAnswers: Record<string, string>,
  page: Page
): Promise<string | null> {
  if (isAutofillTrapPrompt(prompt)) {
    return null;
  }

  const optionLabels = field.optionLabels.slice(0, AUTOAPPLY_AI_ANSWER_MAX_OPTIONS);
  const cacheKey = JSON.stringify({
    prompt: normalizePromptText(prompt),
    tag: field.tag,
    type: field.type,
    optionLabels
  });
  if (AUTOAPPLY_AI_ANSWER_CACHE.has(cacheKey)) {
    return AUTOAPPLY_AI_ANSWER_CACHE.get(cacheKey) ?? null;
  }

  const runtime = getAutoApplyAnswerClient();
  if (runtime == null) {
    AUTOAPPLY_AI_ANSWER_CACHE.set(cacheKey, null);
    return null;
  }

  const identity = resolveAutoApplyIdentity();
  const relevantAnswers = mergedAnswersMap(draft, additionalAnswers);
  const payload = {
    jobTitle: await page.title().catch(() => ""),
    prompt,
    fieldType: field.type,
    htmlTag: field.tag,
    optionLabels,
    candidateProfile: {
      fullName: identity.fullName,
      email: identity.email,
      phone: identity.phone,
      location: identity.location,
      linkedin: identity.linkedin,
      github: identity.github,
      portfolio: identity.portfolio
    },
    knownAnswers: relevantAnswers,
    roleSpecificAnswers: draft.roleSpecificAnswers.slice(0, 4)
  };

  try {
    const response = await runtime.client.chat.completions.create({
      model: runtime.model,
      temperature: 0.2,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: [
            "You help complete job applications honestly.",
            "Return JSON with keys answer and confidence.",
            "If the answer should not be guessed from the provided context, return an empty answer.",
            "For option fields, choose one provided option exactly.",
            "For free-text fields, keep the answer concise and professional."
          ].join(" ")
        },
        {
          role: "user",
          content: JSON.stringify(payload, null, 2)
        }
      ]
    });
    const raw = response.choices[0]?.message?.content ?? "{}";
    const parsed = JSON.parse(raw) as { answer?: unknown };
    const answer = typeof parsed.answer === "string"
      ? coerceVisiblePromptAnswer(field, parsed.answer)
      : null;
    AUTOAPPLY_AI_ANSWER_CACHE.set(cacheKey, answer);
    return answer;
  } catch {
    AUTOAPPLY_AI_ANSWER_CACHE.set(cacheKey, null);
    return null;
  }
}

function inferAnswerForVisiblePrompt(
  prompt: string,
  field: { tag: string; type: string; optionLabels: string[] },
  draft: ApplicationDraft,
  additionalAnswers: Record<string, string>,
  identity: AutoApplyIdentity
): string | null {
  const answerMap = mergedAnswersMap(draft, additionalAnswers);
  const normalizedPrompt = normalizePromptText(prompt);
  const nationalPhone = phoneNationalNumber(identity.phone);
  const countryCode = phoneCountryCode(identity.phone);

  if (/phone extension|extension/i.test(normalizedPrompt)) {
    return null;
  }
  if (isAutofillTrapPrompt(normalizedPrompt)) {
    return null;
  }
  if (/postal code|zip code|\bzip\b/i.test(normalizedPrompt)) {
    return null;
  }
  if (/address line|street address|mailing address/i.test(normalizedPrompt)) {
    return null;
  }
  if (/age of majority|18 years old|secondary school|high school diploma|educational requirement|please confirm that you understand|reside in canada/i.test(normalizedPrompt)) {
    return field.optionLabels.length > 0
      ? chooseOptionLabel(field.optionLabels, ["Yes", "I confirm", "Confirm"]) ?? "Yes"
      : "Yes";
  }
  if (/first name|given name/i.test(normalizedPrompt)) {
    return identity.firstName;
  }
  if (/last name|family name|surname/i.test(normalizedPrompt)) {
    return identity.lastName;
  }
  if (/country phone code|phone code|dial code/i.test(normalizedPrompt)) {
    return field.tag === "select"
      ? chooseOptionLabel(field.optionLabels, ["Canada (+1)", "Canada", "+1", countryCode]) ?? "Canada (+1)"
      : "Canada (+1)";
  }
  if (/phone number|mobile number|cell number/i.test(normalizedPrompt)) {
    return nationalPhone || identity.phone;
  }
  if (/previously employed|previous worker|previous employee|worked for td|employed previously/i.test(normalizedPrompt)) {
    return field.tag === "select"
      ? chooseOptionLabel(field.optionLabels, ["No", "false"]) ?? "No"
      : "No";
  }
  if (/email address|\bemail\b/i.test(normalizedPrompt)) {
    return identity.email;
  }
  if (/linkedin/i.test(normalizedPrompt)) {
    return identity.linkedin;
  }
  if (/github/i.test(normalizedPrompt)) {
    return identity.github;
  }
  if (/\burl\b/i.test(normalizedPrompt) && !/linkedin|github|email|apply|source/i.test(normalizedPrompt)) {
    return identity.portfolio || identity.linkedin;
  }
  if (/website|portfolio/i.test(normalizedPrompt)) {
    return identity.portfolio;
  }
  if (/full name|legal name|\bname\b/i.test(normalizedPrompt)) {
    return identity.fullName;
  }
  if (/sponsorship|visa/i.test(normalizedPrompt)) {
    return field.optionLabels.length > 0
      ? chooseOptionLabel(field.optionLabels, ["No", "No sponsorship required"]) ?? "No"
      : "No";
  }
  if (/gdpr consent type|personal details.*this job only|processed for this job only/i.test(normalizedPrompt)) {
    const preferred = "I would like my personal details to be processed for this job only";
    return field.optionLabels.length > 0
      ? chooseOptionLabel(field.optionLabels, [preferred, "this job only"]) ?? preferred
      : preferred;
  }
  if (/accept gdpr|\bi accept\b/i.test(normalizedPrompt)) {
    return field.optionLabels.length > 0
      ? chooseOptionLabel(field.optionLabels, ["I Accept", "Accept", "Yes", "True"]) ?? "I Accept"
      : "Yes";
  }
  if (/hybrid working policy|happy to proceed|privacy notice|process your personal data|store and process my data|consent/i.test(normalizedPrompt)) {
    if ((field.type === "checkbox" || field.type === "radio") && field.optionLabels.length > 0) {
      return field.optionLabels[0] ?? "Yes";
    }
    return field.optionLabels.length > 0
      ? chooseOptionLabel(field.optionLabels, ["Yes", "I agree", "Agree", "I consent", "Consent"]) ?? "Yes"
      : "Yes";
  }
  if (/\bcountry\b/i.test(normalizedPrompt) && !/phone country code|phone code|dial code/i.test(normalizedPrompt)) {
    return field.optionLabels.length > 0
      ? chooseOptionLabel(field.optionLabels, ["Canada", "Canada (+1)", "CA"]) ?? "Canada"
      : "Canada";
  }
  if (/reside in any of our core hiring locations|core hiring locations/i.test(normalizedPrompt)) {
    return field.optionLabels.length > 0
      ? chooseOptionLabel(field.optionLabels, ["Yes", "True"]) ?? "Yes"
      : "Yes";
  }
  if (/where in the world are you currently living|where are you currently living|what country are you currently living/i.test(normalizedPrompt)) {
    return locationCountry(identity.location);
  }
  if (/linux internals|kernel subsystems|memory management|process scheduling/i.test(normalizedPrompt)) {
    return field.optionLabels.length > 0
      ? chooseOptionLabel(field.optionLabels, ["No", "False"]) ?? "No"
      : "No";
  }
  if (/python or go code.*production environment|experience programming.*python.*production|experience programming.*go.*production/i.test(normalizedPrompt)) {
    return field.optionLabels.length > 0
      ? chooseOptionLabel(field.optionLabels, ["Yes", "True"]) ?? "Yes"
      : "Yes";
  }
  if (/location|city|address/i.test(normalizedPrompt)) {
    return identity.location;
  }

  const matchedKey = chooseBestAnswerKeyForPrompt(prompt, answerMap);
  if (matchedKey != null) {
    const matchedValue = String(answerMap[matchedKey] ?? "").trim();
    if (matchedValue.length > 0) {
      if (field.tag === "select") {
        const optionMatch = chooseOptionLabel(field.optionLabels, [matchedValue]);
        if (optionMatch != null) {
          return optionMatch;
        }
      }
      return matchedValue;
    }
  }

  if (/how did you hear|how did you find|referral source|source/i.test(normalizedPrompt)) {
    return field.tag === "select"
      ? chooseOptionLabel(field.optionLabels, ["LinkedIn", "Job Board"]) ?? "LinkedIn"
      : "LinkedIn";
  }
  if (/authorized to work|work authorization|eligible to work/i.test(normalizedPrompt)) {
    return field.tag === "select"
      ? chooseOptionLabel(field.optionLabels, ["Yes", "Authorized", "Canadian Citizen", "Permanent Resident", "No sponsorship required"]) ?? "Yes"
      : "Yes";
  }
  if (/legally entitled to work in canada|insurance license|ernst\s*&\s*young|relatives|close personal relationship|politically exposed person|government-owned enterprise/i.test(normalizedPrompt)) {
    const preferred = /legally entitled to work in canada/i.test(normalizedPrompt)
      ? ["Yes", "Authorized", "Canadian Citizen", "Permanent Resident"]
      : ["No", "No, I have not", "None"];
    return field.optionLabels.length > 0
      ? chooseOptionLabel(field.optionLabels, preferred) ?? preferred[0]
      : preferred[0];
  }
  if (/employment type|type of employment|employment preferences|full[- ]time|part[- ]time|campus program|seasonal|temporary/i.test(normalizedPrompt)) {
    return field.optionLabels.length > 0
      ? chooseOptionLabel(field.optionLabels, ["Full-Time", "Full Time"]) ?? "Full-Time"
      : "Full-Time";
  }
  if (/weekly hours|hours per week|hours weekly/i.test(normalizedPrompt)) {
    return "37";
  }
  if (/salary|compensation|pay expectation/i.test(normalizedPrompt)) {
    return "200000";
  }
  if (/notice period|start date|available to start|availability/i.test(normalizedPrompt)) {
    return "2 weeks";
  }
  if (/why are you interested|why do you want|motivation|cover letter|tell us about yourself|additional information|summary/i.test(normalizedPrompt)) {
    return [
      `I am excited about this opportunity because it aligns well with my background in analytics, experimentation, and machine learning.`,
      `I enjoy translating complex data into decisions and would bring a practical, business-focused approach to the role.`,
      `My recent work has focused on building analytical and ML solutions that improve revenue, reduce fraud, and support better product decisions.`
    ].join(" ");
  }
  if (/phone|mobile/i.test(normalizedPrompt)) {
    return nationalPhone || identity.phone;
  }
  if (field.tag === "select") {
    return chooseOptionLabel(field.optionLabels, ["Yes", "No", "LinkedIn", "Canada", "Toronto", "Prefer not to say"]);
  }
  return null;
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

function resolveLinkedInAutoApplyTargetUrl(job: JobListing): string | null {
  return resolveLinkedInJobPostingUrl(job.applyUrl, job.metadata, job.sourceUrl);
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

function ensureOsModeSupport(mode: AutoApplyMode): void {
  if (mode === "pyautogui" && process.platform !== "win32") {
    throw new Error("PyAutoGUI autoapply mode currently supports Windows only.");
  }
}

function collectFillContexts(page: Page): FillContextRef[] {
  const contexts: FillContextRef[] = [
    {
      context: page,
      allowOsInput: true
    }
  ];
  for (const frame of page.frames()) {
    if (frame === page.mainFrame()) {
      continue;
    }
    contexts.push({
      context: frame,
      allowOsInput: false
    });
  }
  return contexts;
}

interface LinkedInEntryCandidate extends LinkedInEntryCandidateSample {
  x: number;
  y: number;
}

type ResolvedLinkedInEntryCandidate = LinkedInEntryCandidate & {
  kind: LinkedInEntryKind;
  score: number;
};

async function collectLinkedInEntryCandidates(page: Page): Promise<LinkedInEntryCandidate[]> {
  if (!isLinkedInUrl(page.url())) {
    return [];
  }
  return page.evaluate(() => {
    const browserWindow = globalThis as any;
    const documentRef = browserWindow.document as any;
    if (documentRef == null) {
      return [] as LinkedInEntryCandidate[];
    }
    const viewportHeight = Math.max(1, Number(browserWindow.innerHeight ?? 0));
    const viewportWidth = Math.max(1, Number(browserWindow.innerWidth ?? 0));
    const isVisible = (element: any): boolean => {
      const target = element as any;
      const rect = target.getBoundingClientRect();
      if (rect.width < 8 || rect.height < 8) {
        return false;
      }
      if (rect.bottom < -40 || rect.top > viewportHeight + 140) {
        return false;
      }
      if (rect.right < -40 || rect.left > viewportWidth + 40) {
        return false;
      }
      const style = browserWindow.getComputedStyle?.(target);
      if (style != null && (style.visibility === "hidden" || style.display === "none" || style.pointerEvents === "none")) {
        return false;
      }
      return !target.hasAttribute("disabled") && target.getAttribute("aria-disabled") !== "true";
    };

    const elements = Array.from(documentRef.querySelectorAll("a, button, input[type='submit']")) as any[];
    return elements.filter(isVisible).map((element: any) => {
      const rect = element.getBoundingClientRect();
      const text = (element.innerText ?? element.textContent ?? "").replace(/\s+/g, " ").trim();
      const ariaLabel = String(element.getAttribute("aria-label") ?? "");
      const href = String(element.getAttribute("href") ?? "");
      const className = String(element.getAttribute("class") ?? "");
      const id = String(element.getAttribute("id") ?? "");
      const dataTrackingControlName = String(element.getAttribute("data-tracking-control-name") ?? "");
      const summary = `${text} ${ariaLabel} ${href} ${className} ${id} ${dataTrackingControlName}`.toLowerCase();
      if (!/(apply|easy apply)/i.test(summary)) {
        return null;
      }

      const ancestorHints: string[] = [];
      let current = element.parentElement;
      for (let depth = 0; depth < 6 && current != null; depth += 1) {
        ancestorHints.push([
          current.tagName.toLowerCase(),
          String(current.getAttribute("id") ?? ""),
          String(current.getAttribute("class") ?? "")
        ].join(" ").trim());
        current = current.parentElement;
      }

      return {
        text,
        ariaLabel,
        href,
        className,
        id,
        dataTrackingControlName,
        top: Math.round(rect.top),
        left: Math.round(rect.left),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        viewportHeight,
        ancestorHints,
        x: Math.round(rect.left + (rect.width / 2)),
        y: Math.round(rect.top + (rect.height / 2))
      } satisfies LinkedInEntryCandidate;
    }).filter((candidate): candidate is LinkedInEntryCandidate => candidate != null);
  }).catch(() => [] as LinkedInEntryCandidate[]);
}

async function getLinkedInPrimaryEntryCandidate(
  page: Page,
  preferredKind?: LinkedInEntryKind
): Promise<ResolvedLinkedInEntryCandidate | null> {
  const candidates = await collectLinkedInEntryCandidates(page);
  return pickBestLinkedInEntryCandidate(candidates, preferredKind);
}

async function detectUnavailablePostingReason(page: Page): Promise<string | null> {
  const title = (await page.title().catch(() => "")).toLowerCase();
  const bodyText = ((await page.textContent("body").catch(() => "")) ?? "").toLowerCase();
  const combined = `${title}\n${bodyText}`.replace(/\s+/g, " ");
  const patterns: Array<{ pattern: RegExp; reason: string }> = [
    { pattern: /\b404\b|not found|page not found|error 404/i, reason: "Job page returned a 404/not found response." },
    { pattern: /job posting.*closed|no longer available|position has been filled|no longer accepting applications/i, reason: "Job posting appears closed or unavailable." },
    { pattern: /this page doesn'?t exist|we can'?t find this page|cannot be found/i, reason: "Job page does not exist." }
  ];
  for (const item of patterns) {
    if (item.pattern.test(combined)) {
      return item.reason;
    }
  }
  return null;
}

async function assertPostingAvailable(page: Page): Promise<void> {
  const unavailableReason = await detectUnavailablePostingReason(page);
  if (unavailableReason != null) {
    throw new Error(unavailableReason);
  }
}

interface ApplicationSurfaceState {
  mainControls: number;
  mainForms: number;
  mainFileInputs: number;
  mainContactSignals: number;
  totalControls: number;
  totalForms: number;
  fileInputs: number;
  contactSignals: number;
  hasLinkedInApplyEntry: boolean;
}

async function analyzeApplicationSurface(page: Page): Promise<ApplicationSurfaceState> {
  const contexts = collectFillContexts(page);
  let mainControls = 0;
  let mainForms = 0;
  let mainFileInputs = 0;
  let mainContactSignals = 0;
  let totalControls = 0;
  let totalForms = 0;
  let fileInputs = 0;
  let contactSignals = 0;

  for (const ref of contexts) {
    const context = ref.context;
    const controls = await context.locator("input, textarea, select").count().catch(() => 0);
    const forms = await context.locator("form").count().catch(() => 0);
    const files = await context.locator("input[type='file']").count().catch(() => 0);
    const contact = await context.locator(
      "input[type='email'], input[type='tel'], input[name*='email' i], input[id*='email' i], input[name*='phone' i], input[id*='phone' i], textarea"
    ).count().catch(() => 0);

    totalControls += controls;
    totalForms += forms;
    fileInputs += files;
    contactSignals += contact;

    if (context === page) {
      mainControls += controls;
      mainForms += forms;
      mainFileInputs += files;
      mainContactSignals += contact;
    }
  }

  const hasLinkedInApplyEntry = await getLinkedInPrimaryEntryCandidate(page)
    .then((candidate) => candidate != null)
    .catch(() => false);

  return {
    mainControls,
    mainForms,
    mainFileInputs,
    mainContactSignals,
    totalControls,
    totalForms,
    fileInputs,
    contactSignals,
    hasLinkedInApplyEntry
  };
}

function isApplicationSurfaceReady(page: Page, surface: ApplicationSurfaceState): boolean {
  if (surface.mainFileInputs > 0 && surface.mainControls >= 2) {
    return true;
  }
  if (surface.mainForms > 0 && surface.mainControls >= 3 && surface.mainContactSignals >= 1) {
    if (isLinkedInUrl(page.url()) && surface.hasLinkedInApplyEntry) {
      return false;
    }
    return true;
  }
  if (surface.totalForms > 0 && surface.totalControls >= 6 && surface.contactSignals >= 2 && surface.fileInputs >= 1) {
    if (isLinkedInUrl(page.url()) && surface.hasLinkedInApplyEntry) {
      return false;
    }
    return true;
  }
  return false;
}

function toSafeArtifactToken(value: string, maxLength = 64): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (normalized.length === 0) {
    return "snapshot";
  }
  return normalized.slice(0, maxLength);
}

function debugTimestampToken(value = new Date()): string {
  return value.toISOString().replace(/[:.]/g, "-");
}

function createAutoApplyDebugSession(options: AutoApplySingleRunOptions, jobId: number, targetUrl: string): AutoApplyDebugSession | null {
  if (!options.debugArtifacts) {
    return null;
  }
  const baseDir = options.debugDir == null
    ? path.resolve(rootDir, "logs", "autoapply-test")
    : path.resolve(rootDir, options.debugDir);
  const hostToken = toSafeArtifactToken(getUrlHostname(targetUrl) || "manual-target", 40);
  const runToken = `${debugTimestampToken()}-job-${jobId > 0 ? String(jobId) : "manual"}-${hostToken}`;
  const runDir = path.resolve(baseDir, runToken);
  mkdirSync(runDir, { recursive: true });
  return {
    runDir,
    stepCounter: 0,
    snapshots: []
  };
}

async function collectDebugFieldSamples(page: Page, maxFields = 80): Promise<Array<Record<string, unknown>>> {
  const samples: Array<Record<string, unknown>> = [];
  for (const ref of collectFillContexts(page)) {
    if (samples.length >= maxFields) {
      break;
    }
    const context = ref.context;
    const frameName = context === page
      ? "main"
      : (() => {
        try {
          return context.url();
        } catch {
          return "frame";
        }
      })();
    const remaining = Math.max(0, maxFields - samples.length);
    const contextSamples = await context.locator("input, textarea, select").evaluateAll((elements, frameLabel) => {
      return elements.slice(0, 80).map((element) => {
        const el = element as any;
        const labelText = Array.from(el.labels ?? [])
          .map((label: any) => (label?.textContent ?? "").replace(/\s+/g, " ").trim())
          .filter((entry: string) => entry.length > 0)
          .join(" | ");
        return {
          frame: frameLabel,
          tag: String(el.tagName ?? "").toLowerCase(),
          type: String(el.getAttribute?.("type") ?? ""),
          name: String(el.getAttribute?.("name") ?? ""),
          id: String(el.getAttribute?.("id") ?? ""),
          ariaLabel: String(el.getAttribute?.("aria-label") ?? ""),
          placeholder: String(el.getAttribute?.("placeholder") ?? ""),
          valueLength: String(el.value ?? "").trim().length,
          required: Boolean(el.required),
          disabled: Boolean(el.disabled),
          labelText
        };
      });
    }, frameName).catch(() => [] as Array<Record<string, unknown>>);
    samples.push(...contextSamples.slice(0, remaining));
  }
  return samples;
}

async function collectDebugCtaSamples(page: Page, maxEntries = 40): Promise<Array<Record<string, unknown>>> {
  return page.locator("button, a, input[type='submit']").evaluateAll((elements) => {
    return elements
      .map((element) => {
        const el = element as any;
        const text = (el.innerText ?? el.textContent ?? "").replace(/\s+/g, " ").trim();
        const aria = String(el.getAttribute?.("aria-label") ?? "");
        const summary = `${text} ${aria}`.toLowerCase();
        if (!/(apply|easy apply|start|continue|next|review|submit|upload|resume)/i.test(summary)) {
          return null;
        }
        return {
          tag: String(el.tagName ?? "").toLowerCase(),
          text,
          ariaLabel: aria,
          href: String(el.getAttribute?.("href") ?? ""),
          type: String(el.getAttribute?.("type") ?? ""),
          id: String(el.getAttribute?.("id") ?? ""),
          className: String(el.getAttribute?.("class") ?? ""),
          dataQa: String(el.getAttribute?.("data-qa") ?? ""),
          dataAutomationId: String(el.getAttribute?.("data-automation-id") ?? "")
        };
      })
      .filter((entry) => entry != null)
      .slice(0, maxEntries);
  }).catch(() => [] as Array<Record<string, unknown>>);
}

async function collectDebugPageErrors(page: Page, maxEntries = 25): Promise<string[]> {
  return page.evaluate((limit) => {
    const selectors = [
      "[data-automation-id='errorHeading'] button",
      "[data-automation-id='errorHeading'] h4",
      "[data-automation-id='inputAlert']",
      "[role='alert']",
      "[aria-invalid='true']"
    ];
    const root = (globalThis as any).document as any;
    const normalize = (value: string): string => value.replace(/\s+/g, " ").trim();
    const isVisible = (element: any): boolean => {
      const rect = element?.getBoundingClientRect?.();
      if (rect == null || rect.width <= 0 || rect.height <= 0) {
        return false;
      }
      const browserWindow = globalThis as any;
      const style = browserWindow.getComputedStyle?.(element);
      return style?.visibility !== "hidden" && style?.display !== "none";
    };
    const entries: string[] = [];
    const push = (value: string) => {
      const normalized = normalize(value);
      if (normalized.length === 0 || normalized.length > 500 || entries.includes(normalized)) {
        return;
      }
      entries.push(normalized);
    };

    for (const selector of selectors) {
      const nodes = Array.from(root?.querySelectorAll?.(selector) ?? []);
      for (const node of nodes) {
        if (entries.length >= limit) {
          break;
        }
        if (!isVisible(node)) {
          continue;
        }
        const textContent = String((node as any).textContent ?? "");
        if (selector === "[role='alert']" && !/(error|invalid|required|unable|failed|problem|warning)/i.test(textContent)) {
          continue;
        }
        if (selector === "[aria-invalid='true']") {
          const el = node as any;
          const describedByIds = String(el.getAttribute?.("aria-describedby") ?? "")
            .split(/\s+/)
            .filter((entry: string) => entry.length > 0);
          const labels = Array.from(el.labels ?? [])
            .map((label: any) => normalize(String(label?.textContent ?? "")))
            .filter((entry: string) => entry.length > 0)
            .join(" ");
          const described = describedByIds
            .map((id: string) => normalize(String(root?.getElementById?.(id)?.textContent ?? "")))
            .filter((entry: string) => entry.length > 0)
            .join(" ");
          push([labels, described].filter((entry) => entry.length > 0).join(" - "));
          continue;
        }
        push(textContent);
      }
      if (entries.length >= limit) {
        break;
      }
    }
    return entries.slice(0, limit);
  }, maxEntries).catch(() => [] as string[]);
}

async function describeBlockingSurface(page: Page): Promise<string> {
  const title = await page.title().catch(() => "");
  const headings = await page.locator("h1, h2, h3, [data-automation-id='signInContent']").evaluateAll((elements) => {
    return elements
      .map((element) => String((element as any).textContent ?? "").replace(/\s+/g, " ").trim())
      .filter((entry) => entry.length > 0)
      .slice(0, 4);
  }).catch(() => [] as string[]);
  const buttons = await page.locator("button, a").evaluateAll((elements) => {
    return elements
      .map((element) => String((element as any).textContent ?? "").replace(/\s+/g, " ").trim())
      .filter((entry) => entry.length > 0)
      .slice(0, 8);
  }).catch(() => [] as string[]);
  const pageErrors = await collectDebugPageErrors(page, 8);
  return [
    title.length > 0 ? `title=${title}` : "",
    headings.length > 0 ? `headings=${headings.join(" | ")}` : "",
    pageErrors.length > 0 ? `errors=${pageErrors.join(" | ")}` : "",
    buttons.length > 0 ? `buttons=${buttons.join(" | ")}` : ""
  ].filter((entry) => entry.length > 0).join("; ");
}

async function captureAutoApplyDebugSnapshot(
  session: AutoApplyDebugSession | null,
  page: Page,
  label: string,
  details: Record<string, unknown> = {}
): Promise<void> {
  if (session == null) {
    return;
  }
  session.stepCounter += 1;
  const prefix = String(session.stepCounter).padStart(2, "0");
  const safeLabel = toSafeArtifactToken(label, 80);
  const baseName = `${prefix}-${safeLabel}`;
  const screenshotFile = `${baseName}.png`;
  const stateFile = `${baseName}.json`;
  const htmlFile = `${baseName}.html`;
  const screenshotPath = path.resolve(session.runDir, screenshotFile);
  const statePath = path.resolve(session.runDir, stateFile);
  const htmlPath = path.resolve(session.runDir, htmlFile);

  await page.screenshot({
    path: screenshotPath,
    fullPage: true,
    animations: "disabled",
    caret: "hide"
  }).catch(() => undefined);

  const surface = await analyzeApplicationSurface(page).catch(() => null as ApplicationSurfaceState | null);
  const fieldSamples = await collectDebugFieldSamples(page);
  const ctaSamples = await collectDebugCtaSamples(page);
  const pageErrors = await collectDebugPageErrors(page);
  const frameUrls = page.frames().map((frame) => {
    try {
      return frame.url();
    } catch {
      return "";
    }
  });
  const title = await page.title().catch(() => "");
  const url = page.url();

  const statePayload = {
    timestamp: new Date().toISOString(),
    label,
    url,
    title,
    surface,
    frameUrls,
    fieldSampleCount: fieldSamples.length,
    fieldSamples,
    ctaSamples,
    pageErrors,
    ...details
  };
  writeFileSync(statePath, JSON.stringify(statePayload, null, 2), "utf8");

  const markup = await page.content().catch(() => "");
  if (markup.length > 0) {
    writeFileSync(htmlPath, markup, "utf8");
  }

  session.snapshots.push({
    step: session.stepCounter,
    label,
    timestamp: new Date().toISOString(),
    url,
    screenshotFile,
    stateFile,
    htmlFile
  });
}

function finalizeAutoApplyDebugSession(
  session: AutoApplyDebugSession | null,
  payload: Record<string, unknown>
): void {
  if (session == null) {
    return;
  }
  const summaryPath = path.resolve(session.runDir, "summary.json");
  writeFileSync(summaryPath, JSON.stringify({
    generatedAt: new Date().toISOString(),
    ...payload,
    snapshots: session.snapshots
  }, null, 2), "utf8");
}

async function locatorViewportPoint(locator: Locator): Promise<{ x: number; y: number; scale: number } | null> {
  return await locator.first().evaluate((element) => {
    const target = element as any;
    const browserWindow = globalThis as any;
    const rect = target.getBoundingClientRect();
    if (!Number.isFinite(rect.left) || !Number.isFinite(rect.top) || rect.width <= 0 || rect.height <= 0) {
      return null;
    }
    return {
      x: Math.round(rect.left + (rect.width / 2)),
      y: Math.round(rect.top + (rect.height / 2)),
      scale: Number(browserWindow.devicePixelRatio ?? 1) || 1
    };
  }).catch(() => null as { x: number; y: number; scale: number } | null);
}

async function clickLocatorWithOsInput(locator: Locator, osInput: WindowsOsInputDriver): Promise<boolean> {
  if (await locator.count().catch(() => 0) === 0) {
    return false;
  }
  const target = locator.first();
  await target.scrollIntoViewIfNeeded().catch(() => undefined);
  await target.evaluate(() => {
    const browserWindow = globalThis as any;
    browserWindow.focus?.();
  }).catch(() => undefined);
  const titleHint = await target.evaluate(() => String((globalThis as any).document?.title ?? "LinkedIn")).catch(() => "LinkedIn");
  await osInput.activateWindow(titleHint).catch(() => undefined);
  const point = await locatorViewportPoint(target);
  if (point == null) {
    return false;
  }
  await osInput.clickViewportPoint(point.x, point.y, point.scale);
  await sleep(80);
  return true;
}

interface BrowserWindowMetrics {
  deviceScaleFactor: number;
}

function normalizeOcrToken(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function buildOcrTargetTokens(targetPhrases: string[]): string[] {
  const tokens: string[] = [];
  for (const phrase of targetPhrases) {
    for (const token of phrase.toLowerCase().split(/[^a-z0-9]+/)) {
      const normalized = normalizeOcrToken(token);
      if (normalized.length >= 3) {
        tokens.push(normalized);
      }
    }
  }
  return unique(tokens);
}

async function getBrowserWindowMetrics(page: Page): Promise<BrowserWindowMetrics | null> {
  return page.evaluate(() => {
    const browserWindow = globalThis as any;
    const metrics = {
      deviceScaleFactor: Number(browserWindow.devicePixelRatio ?? 1) || 1
    };
    if (!Number.isFinite(metrics.deviceScaleFactor) || metrics.deviceScaleFactor <= 0) {
      return null;
    }
    return metrics;
  }).catch(() => null as BrowserWindowMetrics | null);
}

interface OcrWordCandidate {
  text: string;
  confidence: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

function extractOcrWordCandidates(result: Tesseract.RecognizeResult): OcrWordCandidate[] {
  const words: OcrWordCandidate[] = [];
  for (const block of result.data.blocks ?? []) {
    for (const paragraph of block.paragraphs ?? []) {
      for (const line of paragraph.lines ?? []) {
        for (const word of line.words ?? []) {
          words.push({
            text: word.text ?? "",
            confidence: Number(word.confidence ?? 0),
            x0: Number(word.bbox?.x0 ?? 0),
            y0: Number(word.bbox?.y0 ?? 0),
            x1: Number(word.bbox?.x1 ?? 0),
            y1: Number(word.bbox?.y1 ?? 0)
          });
        }
      }
    }
  }
  return words;
}

async function isLikelyClickablePoint(page: Page, cssX: number, cssY: number): Promise<boolean> {
  return page.evaluate(({ x, y }) => {
    const node = (globalThis as any).document?.elementFromPoint?.(x, y) as any;
    if (node == null) {
      return false;
    }
    const clickable = node.closest?.(
      "button, a, input, label, textarea, select, [role='button'], [role='link'], [onclick], [tabindex]"
    );
    if (clickable == null) {
      return false;
    }
    const style = (globalThis as any).getComputedStyle?.(clickable);
    if (style != null && (style.visibility === "hidden" || style.display === "none")) {
      return false;
    }
    if (style?.pointerEvents === "none") {
      return false;
    }
    return true;
  }, { x: cssX, y: cssY }).catch(() => false);
}

async function clickByOcrText(page: Page, targetPhrases: string[], osInput: WindowsOsInputDriver): Promise<boolean> {
  const targetTokens = buildOcrTargetTokens(targetPhrases);
  if (targetTokens.length === 0) {
    return false;
  }
  const titleHint = await page.title().catch(() => "LinkedIn");
  await osInput.activateWindow(titleHint).catch(() => undefined);
  const metrics = await getBrowserWindowMetrics(page);
  if (metrics == null) {
    return false;
  }

  const screenshot = await page.screenshot({
    type: "png",
    fullPage: false,
    scale: "css",
    animations: "disabled",
    caret: "hide"
  }).catch(() => null as Buffer | null);
  if (screenshot == null) {
    return false;
  }

  mkdirSync(TESSERACT_CACHE_DIR, { recursive: true });

  const recognition = await Tesseract.recognize(screenshot, "eng", {
    logger: () => undefined,
    cachePath: TESSERACT_CACHE_DIR
  }).catch(() => null as Tesseract.RecognizeResult | null);
  if (recognition == null) {
    return false;
  }

  const candidates = extractOcrWordCandidates(recognition)
    .map((word) => {
      const normalized = normalizeOcrToken(word.text);
      const token = targetTokens.find((entry) => normalized === entry || normalized.includes(entry) || entry.includes(normalized));
      if (token == null) {
        return null;
      }
      const width = Math.max(0, word.x1 - word.x0);
      const height = Math.max(0, word.y1 - word.y0);
      if (width < 4 || height < 4) {
        return null;
      }
      const score = Number(word.confidence) + (normalized === token ? 55 : normalized.includes(token) ? 35 : 20);
      return {
        ...word,
        score
      };
    })
    .filter((entry): entry is OcrWordCandidate & { score: number } => entry != null)
    .sort((left, right) => right.score - left.score);

  for (const candidate of candidates.slice(0, 14)) {
    const cssX = candidate.x0 + ((candidate.x1 - candidate.x0) / 2);
    const cssY = candidate.y0 + ((candidate.y1 - candidate.y0) / 2);
    const clickable = await isLikelyClickablePoint(page, cssX, cssY);
    if (!clickable) {
      continue;
    }
    const clicked = await osInput.clickViewportPoint(cssX, cssY, metrics.deviceScaleFactor).then(() => true).catch(() => false);
    if (!clicked) {
      continue;
    }
    await sleep(120);
    return true;
  }
  return false;
}

async function isAutofillTrapLocator(locator: Locator): Promise<boolean> {
  return locator.first().evaluate((element) => {
    const el = element as any;
    const root = (el.closest?.("[data-automation-id^='formField-'], fieldset, [role='group'], label") ?? el.parentElement) as any;
    const summary = [
      String(el.getAttribute?.("name") ?? ""),
      String(el.getAttribute?.("id") ?? ""),
      String(el.getAttribute?.("aria-label") ?? ""),
      String(el.getAttribute?.("placeholder") ?? ""),
      String(root?.textContent ?? ""),
      Array.from(el.labels ?? [])
        .map((label: any) => String(label?.textContent ?? ""))
        .join(" ")
    ].join(" ").replace(/\s+/g, " ").trim().toLowerCase();
    return summary;
  }).then((summary) => isAutofillTrapPrompt(summary)).catch(() => false);
}

interface OcrTextCandidate extends OcrWordCandidate {
  score: number;
}

async function collectOcrTextCandidates(page: Page, targetPhrases: string[]): Promise<{
  metrics: BrowserWindowMetrics;
  candidates: OcrTextCandidate[];
} | null> {
  const targetTokens = buildOcrTargetTokens(targetPhrases);
  if (targetTokens.length === 0) {
    return null;
  }
  const metrics = await getBrowserWindowMetrics(page);
  if (metrics == null) {
    return null;
  }
  const screenshot = await page.screenshot({
    type: "png",
    fullPage: false,
    scale: "css",
    animations: "disabled",
    caret: "hide"
  }).catch(() => null as Buffer | null);
  if (screenshot == null) {
    return null;
  }
  mkdirSync(TESSERACT_CACHE_DIR, { recursive: true });
  const recognition = await Tesseract.recognize(screenshot, "eng", {
    logger: () => undefined,
    cachePath: TESSERACT_CACHE_DIR
  }).catch(() => null as Tesseract.RecognizeResult | null);
  if (recognition == null) {
    return null;
  }

  const candidates = extractOcrWordCandidates(recognition)
    .map((word) => {
      const normalized = normalizeOcrToken(word.text);
      const token = targetTokens.find((entry) => normalized === entry || normalized.includes(entry) || entry.includes(normalized));
      if (token == null) {
        return null;
      }
      const width = Math.max(0, word.x1 - word.x0);
      const height = Math.max(0, word.y1 - word.y0);
      if (width < 4 || height < 4) {
        return null;
      }
      return {
        ...word,
        score: Number(word.confidence) + (normalized === token ? 55 : normalized.includes(token) ? 35 : 20)
      };
    })
    .filter((entry): entry is OcrTextCandidate => entry != null)
    .sort((left, right) => right.score - left.score);

  return {
    metrics,
    candidates
  };
}

async function resolveNearbyFillControlPoint(page: Page, cssX: number, cssY: number): Promise<{ x: number; y: number } | null> {
  return page.evaluate(({ x, y }) => {
    const root = (globalThis as any).document as any;
    const inputSelector = "input:not([type='hidden']):not([disabled]), textarea:not([disabled]), select:not([disabled]), [contenteditable='true']";
    const isVisible = (element: any) => {
      if (element == null) {
        return false;
      }
      const rect = element.getBoundingClientRect?.();
      if (rect == null || rect.width < 2 || rect.height < 2) {
        return false;
      }
      const style = (globalThis as any).getComputedStyle?.(element);
      if (style != null && (style.visibility === "hidden" || style.display === "none" || style.pointerEvents === "none")) {
        return false;
      }
      return true;
    };
    const resolveControl = (node: any) => {
      if (node == null) {
        return null;
      }
      let control = node.matches?.(inputSelector) ? node : node.closest?.(inputSelector);
      if (control != null && isVisible(control)) {
        return control;
      }
      const label = node.closest?.("label");
      if (label != null) {
        const htmlFor = String(label.getAttribute?.("for") ?? "");
        if (htmlFor.length > 0) {
          const linked = root.getElementById?.(htmlFor);
          if (linked != null && linked.matches?.(inputSelector) && isVisible(linked)) {
            return linked;
          }
        }
        const nested = label.querySelector?.(inputSelector);
        if (nested != null && isVisible(nested)) {
          return nested;
        }
      }
      return null;
    };

    const width = Math.max(1, Number((globalThis as any).innerWidth ?? 0));
    const height = Math.max(1, Number((globalThis as any).innerHeight ?? 0));
    const clamp = (value: number, max: number) => Math.max(1, Math.min(max - 2, Math.round(value)));
    const probes = [
      { px: x, py: y },
      { px: x + 115, py: y },
      { px: x + 180, py: y },
      { px: x + 75, py: y + 24 },
      { px: x + 140, py: y + 24 },
      { px: x, py: y + 24 },
      { px: x + 240, py: y }
    ];

    for (const probe of probes) {
      const px = clamp(probe.px, width);
      const py = clamp(probe.py, height);
      const hit = root.elementFromPoint?.(px, py);
      const control = resolveControl(hit);
      if (control == null) {
        continue;
      }
      const rect = control.getBoundingClientRect();
      return {
        x: Math.round(rect.left + Math.min(rect.width * 0.35, 140)),
        y: Math.round(rect.top + Math.max(8, Math.min(rect.height * 0.5, 28)))
      };
    }
    return null;
  }, { x: cssX, y: cssY }).catch(() => null as { x: number; y: number } | null);
}

function ocrTargetsForAnswerKey(key: string): string[] {
  const tokens = resolveAnswerTokens(key)
    .flatMap((token) => token.split(/\s+/))
    .map((token) => token.trim().toLowerCase())
    .filter((token) => token.length >= 3);
  const normalizedKey = key.trim().toLowerCase();
  if (normalizedKey === "portfolio") {
    tokens.push("portfolio", "website", "url");
  }
  if (normalizedKey === "location") {
    tokens.push("location", "city", "address");
  }
  return unique(tokens);
}

async function hasFilledValueOnPage(page: Page, value: string): Promise<boolean> {
  const expected = value.trim().toLowerCase();
  if (expected.length === 0) {
    return false;
  }
  const shortExpected = expected.slice(0, Math.min(18, expected.length));
  return page.evaluate(({ token, minLength }) => {
    const controls = Array.from(
      ((globalThis as any).document as any)?.querySelectorAll?.("input, textarea, select") ?? []
    ) as Array<{ value?: string }>;
    return controls.some((control) => {
      const fieldValue = String(control?.value ?? "").trim().toLowerCase();
      if (fieldValue.length < minLength) {
        return false;
      }
      return fieldValue.includes(token) || token.includes(fieldValue);
    });
  }, {
    token: shortExpected,
    minLength: Math.max(3, Math.min(8, shortExpected.length))
  }).catch(() => false);
}

async function fillFieldByOcr(page: Page, key: string, value: string, osInput: WindowsOsInputDriver): Promise<boolean> {
  const surface = await analyzeApplicationSurface(page).catch(() => null as ApplicationSurfaceState | null);
  if (surface != null && surface.mainForms === 0 && surface.mainControls < 6 && surface.mainFileInputs === 0) {
    return false;
  }
  const titleHint = await page.title().catch(() => "LinkedIn");
  await osInput.activateWindow(titleHint).catch(() => undefined);
  const ocrTargets = ocrTargetsForAnswerKey(key);
  if (ocrTargets.length === 0) {
    return false;
  }
  const scan = await collectOcrTextCandidates(page, ocrTargets);
  if (scan == null || scan.candidates.length === 0) {
    return false;
  }

  for (const candidate of scan.candidates.slice(0, 20)) {
    const centerX = candidate.x0 + ((candidate.x1 - candidate.x0) / 2);
    const centerY = candidate.y0 + ((candidate.y1 - candidate.y0) / 2);
    const controlPoint = await resolveNearbyFillControlPoint(page, centerX, centerY);
    if (controlPoint == null) {
      continue;
    }
    const clicked = await osInput.clickViewportPoint(controlPoint.x, controlPoint.y, scan.metrics.deviceScaleFactor).then(() => true).catch(() => false);
    if (!clicked) {
      continue;
    }
    await sleep(70);
    await osInput.sendKeys("^a").catch(() => undefined);
    await sleep(30);
    await osInput.sendKeys("{BACKSPACE}").catch(() => undefined);
    await sleep(35);
    await osInput.typeText(value).catch(() => undefined);
    await sleep(Math.min(360, Math.max(90, value.length * 2)));
    const filled = await hasFilledValueOnPage(page, value);
    if (filled) {
      return true;
    }
  }
  return false;
}

async function clickAdaptiveCandidate(
  page: Page,
  selectors: string[],
  ocrTargets: string[],
  osInput?: WindowsOsInputDriver,
  timeoutMs = 12000,
  includeFrames = false,
  settleMode: "full" | "light" = "full",
  ocrFirst = false,
  requireDomCandidateForOcr = false
): Promise<boolean> {
  const hasDomCandidate = requireDomCandidateForOcr
    ? await hasAnySelectorCandidate(page, selectors, includeFrames)
    : true;
  if (ocrFirst && osInput != null && ocrTargets.length > 0 && hasDomCandidate) {
    const ocrClickedFirst = await clickByOcrText(page, ocrTargets, osInput);
    if (ocrClickedFirst) {
      if (settleMode === "light") {
        await waitForLightSettle(page);
      } else {
        await waitForPageSettle(page);
      }
      return true;
    }
  }

  const clicked = await clickFirstCandidate(page, selectors, osInput, timeoutMs, includeFrames, settleMode);
  if (clicked) {
    return true;
  }
  if (osInput == null || ocrTargets.length === 0) {
    return false;
  }
  if (!hasDomCandidate) {
    return false;
  }
  const ocrClicked = await clickByOcrText(page, ocrTargets, osInput);
  if (!ocrClicked) {
    return false;
  }
  if (settleMode === "light") {
    await waitForLightSettle(page);
  } else {
    await waitForPageSettle(page);
  }
  return true;
}

async function isCheckboxLikeSelected(locator: Locator): Promise<boolean> {
  return locator.first().evaluate((element) => {
    const input = element as any;
    const root = (
      input.closest?.("[role='checkbox'], [role='radio'], .css-d3pjdr, [data-automation-id^='formField-'], fieldset")
      ?? input.parentElement
    ) as any;
    const inputChecked = Boolean(input.checked)
      || String(input.getAttribute?.("aria-checked") ?? "").toLowerCase() === "true";
    if (inputChecked) {
      return true;
    }
    const selectedNode = root?.querySelector?.("[aria-checked='true'], input:checked");
    if (selectedNode != null) {
      return true;
    }
    const classes = [
      String(root?.className ?? ""),
      String(root?.parentElement?.className ?? "")
    ].join(" ").toLowerCase();
    return /\bselected\b|\bchecked\b|\bactive\b/.test(classes);
  }).catch(() => false);
}

async function clickCheckboxLikeControl(locator: Locator, osInput?: WindowsOsInputDriver): Promise<boolean> {
  const field = locator.first();
  await field.scrollIntoViewIfNeeded().catch(() => undefined);
  if (await isCheckboxLikeSelected(field)) {
    return true;
  }

  const inputId = ((await field.getAttribute("id")) ?? "").trim();
  const clickTargets: Locator[] = [];
  if (inputId.length > 0) {
    clickTargets.push(field.locator(`xpath=ancestor::*[1]/following-sibling::label[@for="${inputId}"]`).first());
    clickTargets.push(field.locator(`xpath=ancestor::*[2]//label[@for="${inputId}"]`).first());
  }
  clickTargets.push(field.locator("xpath=ancestor::*[@role='checkbox' or @role='radio'][1]").first());
  clickTargets.push(field.locator("xpath=ancestor::*[contains(@class,'css-d3pjdr')][1]").first());
  clickTargets.push(field.locator("xpath=ancestor::*[contains(@class,'css-1utp272')][1]").first());
  clickTargets.push(field);

  for (const target of clickTargets) {
    if (await target.count().catch(() => 0) === 0) {
      continue;
    }
    if (await target.isDisabled().catch(() => false)) {
      continue;
    }
    await target.scrollIntoViewIfNeeded().catch(() => undefined);
    const clicked = osInput != null
      ? await clickLocatorWithOsInput(target, osInput).catch(() => false)
      : await target.click({ force: true, timeout: 3000 }).then(() => true).catch(() => false);
    if (!clicked) {
      await target.click({ force: true, timeout: 3000 }).catch(() => undefined);
    }
    await sleep(120);
    if (await isCheckboxLikeSelected(field)) {
      return true;
    }
  }

  const focused = await field.focus().then(() => true).catch(() => false);
  if (focused) {
    await field.press(" ").catch(() => undefined);
    await sleep(120);
    if (await isCheckboxLikeSelected(field)) {
      return true;
    }
  }

  await field.check({ force: true }).catch(() => undefined);
  await sleep(120);
  if (await isCheckboxLikeSelected(field)) {
    return true;
  }

  return field.evaluate((element) => {
    const input = element as any;
    const root = (
      input.closest?.("[role='checkbox'], [role='radio'], .css-d3pjdr, [data-automation-id^='formField-'], fieldset")
      ?? input.parentElement
    ) as any;
    const documentRef = input.ownerDocument as any;
    const inputId = String(input.id ?? "").trim();
    const label = inputId.length > 0
      ? documentRef?.querySelector?.(`label[for="${inputId.replace(/"/g, "\\\"")}"]`)
      : null;
    input.checked = true;
    input.setAttribute("aria-checked", "true");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    label?.dispatchEvent?.(new (globalThis as any).MouseEvent("click", { bubbles: true, cancelable: true }));
    root?.dispatchEvent?.(new (globalThis as any).MouseEvent("click", { bubbles: true, cancelable: true }));
    return Boolean(input.checked)
      || String(input.getAttribute?.("aria-checked") ?? "").toLowerCase() === "true"
      || root?.querySelector?.("[aria-checked='true'], input:checked") != null;
  }).catch(() => false);
}

async function tryFillLocator(locator: Locator, value: string, osInput?: WindowsOsInputDriver): Promise<boolean> {
  if (await locator.count().catch(() => 0) === 0) {
    return false;
  }
  const field = locator.first();
  if (await field.isDisabled().catch(() => false)) {
    return false;
  }
  if (await isAutofillTrapLocator(field)) {
    return false;
  }
  const tag = await field.evaluate((element) => String((element as any).tagName ?? "").toLowerCase()).catch(() => "");
  const type = (await field.getAttribute("type"))?.toLowerCase() ?? "";
  if (type === "hidden") {
    return false;
  }

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
    const controlLabel = await field.evaluate((element) => Array.from((element as any).labels ?? [])
      .map((label: any) => String(label?.textContent ?? "").replace(/\s+/g, " ").trim().toLowerCase())
      .filter((entry: string) => entry.length > 0)
      .join(" ")).catch(() => "");
    const candidateValues = unique([
      normalizedValue,
      normalizedValue === "yes" ? "true" : "",
      normalizedValue === "yes" ? "1" : "",
      normalizedValue === "no" ? "false" : "",
      normalizedValue === "no" ? "0" : "",
      normalizedValue === "true" ? "yes" : "",
      normalizedValue === "false" ? "no" : ""
    ]).filter((entry) => entry.length > 0);
    const matchesControl = candidateValues.some((candidate) => {
      if (controlValue.length > 0 && (controlValue === candidate || controlValue.includes(candidate) || candidate.includes(controlValue))) {
        return true;
      }
      if (controlLabel.length > 0 && (controlLabel === candidate || controlLabel.includes(candidate) || candidate.includes(controlLabel))) {
        return true;
      }
      return false;
    });
    if ((controlValue.length > 0 || controlLabel.length > 0) && !matchesControl) {
      return false;
    }
    return clickCheckboxLikeControl(field, osInput);
  }

  if (osInput != null) {
    let clicked = false;
    try {
      clicked = await clickLocatorWithOsInput(field, osInput);
      if (clicked) {
        await sleep(50);
        const domFocused = await isLocatorDomFocused(field);
        if (!domFocused) {
          clicked = false;
        }
      }
      if (clicked) {
        await osInput.sendKeys("^a");
        await sleep(40);
        await osInput.sendKeys("{BACKSPACE}");
        await sleep(40);
        await osInput.typeText(value);
        await sleep(Math.min(300, Math.max(80, value.length * 2)));
        const filledValue = await field.inputValue().catch(() => "");
        if (doesFilledValueMatchTarget(filledValue, value)) {
          return true;
        }
      }
    } catch {
    // PyAutoGUI key events can fail intermittently on Windows; fallback to Playwright fill below.
    }
  }

  await field.fill(value).catch(() => undefined);
  const filled = await field.inputValue().catch(() => "");
  return doesFilledValueMatchTarget(filled, value);
}

function doesFilledValueMatchTarget(actualValue: string, targetValue: string): boolean {
  const actual = actualValue.trim();
  const target = targetValue.trim();
  if (actual.length === 0 || target.length === 0) {
    return false;
  }
  const normalizeUrl = (value: string) => value.replace(/\/+$/, "").toLowerCase();
  if (/^https?:\/\//i.test(target)) {
    return normalizeUrl(actual) === normalizeUrl(target);
  }
  const targetDigits = target.replace(/\D+/g, "");
  const actualDigits = actual.replace(/\D+/g, "");
  const isNumericLike = /^[+\d\s()./-]+$/.test(target) && targetDigits.length > 0;
  if (isNumericLike) {
    return actualDigits === targetDigits;
  }
  return actual.toLowerCase() === target.toLowerCase();
}

async function isLocatorDomFocused(locator: Locator): Promise<boolean> {
  return locator.first().evaluate((element) => {
    const documentRef = (element.ownerDocument ?? (globalThis as any).document) as any;
    const activeElement = documentRef?.activeElement as any;
    return activeElement === element;
  }).catch(() => false);
}

async function firstExistingLocator(locators: Locator[]): Promise<Locator | null> {
  for (const locator of locators) {
    if (await locator.count().catch(() => 0)) {
      return locator.first();
    }
  }
  return null;
}

async function tryFillWithSelectors(context: FillContext, selectors: string[], value: string, osInput?: WindowsOsInputDriver): Promise<boolean> {
  for (const selector of selectors) {
    const locator = context.locator(selector).first();
    if (await tryFillLocator(locator, value, osInput)) {
      return true;
    }
  }
  return false;
}

async function fillDraftFieldInContext(context: FillContext, key: string, value: string, osInput?: WindowsOsInputDriver): Promise<boolean> {
  const normalizedKey = key.trim();
  if (normalizedKey.toLowerCase() === "full_name") {
    const parts = splitName(value);
    let filledPart = false;
    const firstNameSelectors = [
      `input[name="legalName--firstName"]`,
      `input[id="name--legalName--firstName"]`,
      `input[name*="firstName" i]`,
      `input[id*="firstName" i]`,
      `input[autocomplete="given-name"]`
    ];
    const lastNameSelectors = [
      `input[name="legalName--lastName"]`,
      `input[id="name--legalName--lastName"]`,
      `input[name*="lastName" i]`,
      `input[id*="lastName" i]`,
      `input[autocomplete="family-name"]`
    ];
    if (parts.firstName.length > 0) {
      filledPart = await tryFillWithSelectors(context, firstNameSelectors, parts.firstName, osInput) || filledPart;
    }
    if (parts.lastName.length > 0) {
      filledPart = await tryFillWithSelectors(context, lastNameSelectors, parts.lastName, osInput) || filledPart;
    }
    if (filledPart) {
      return true;
    }
  }
  if (normalizedKey.toLowerCase() === "phone") {
    const normalizedPhoneValue = phoneNationalNumber(value) || value;
    const phoneSelectors = [
      `input[name="phoneNumber"]`,
      `input[id="phoneNumber"]`,
      `input[id*="phoneNumber" i]:not([id*="extension" i])`,
      `input[name*="phoneNumber" i]:not([name*="extension" i])`,
      `input[type="tel"]`,
      `input[autocomplete="tel"]`,
      `input[aria-label*="phone number" i]:not([aria-label*="extension" i])`,
      `input[placeholder*="phone number" i]:not([placeholder*="extension" i])`
    ];
    if (await tryFillWithSelectors(context, phoneSelectors, normalizedPhoneValue, osInput)) {
      return true;
    }
    if (await tryFillLocator(context.getByLabel(/^(?!.*extension).*phone(?: number)?/i).first(), normalizedPhoneValue, osInput)) {
      return true;
    }
  }
  if (normalizedKey.toLowerCase() === "location") {
    const cityValue = locationCity(value);
    const locationSelectors = [
      `input[name="city"]`,
      `input[id="city"]`,
      `input[id*="city" i]`,
      `input[name*="city" i]`,
      `input[aria-label*="city" i]`,
      `input[placeholder*="city" i]`,
      `input[name="location"]`,
      `input[id="location"]`
    ];
    if (await tryFillWithSelectors(context, locationSelectors, cityValue, osInput)) {
      return true;
    }
    if (await tryFillLocator(context.getByLabel(/\bcity\b|\blocation\b/i).first(), cityValue, osInput)) {
      return true;
    }
  }
  const directSelectors = [
    `input[name="${escapeCssAttributeValue(normalizedKey)}"]`,
    `textarea[name="${escapeCssAttributeValue(normalizedKey)}"]`,
    `select[name="${escapeCssAttributeValue(normalizedKey)}"]`,
    `input[id="${escapeCssAttributeValue(normalizedKey)}"]`,
    `textarea[id="${escapeCssAttributeValue(normalizedKey)}"]`,
    `select[id="${escapeCssAttributeValue(normalizedKey)}"]`
  ];
  if (await tryFillWithSelectors(context, directSelectors, value, osInput)) {
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
    if (await tryFillWithSelectors(context, tokenSelectors, value, osInput)) {
      return true;
    }

    const tokenPattern = new RegExp(escapeRegExp(token), "i");
    if (await tryFillLocator(context.getByLabel(tokenPattern).first(), value, osInput)) {
      return true;
    }
    if (await tryFillLocator(context.getByPlaceholder(tokenPattern).first(), value, osInput)) {
      return true;
    }
  }
  return false;
}

async function fillDraftField(page: Page, key: string, value: string, osInput?: WindowsOsInputDriver): Promise<boolean> {
  const contexts = collectFillContexts(page);
  for (const ref of contexts) {
    const filled = await fillDraftFieldInContext(
      ref.context,
      key,
      value,
      ref.allowOsInput ? osInput : undefined
    );
    if (filled) {
      return true;
    }
  }
  if (osInput != null) {
    const hasLikelyField = await hasPotentialField(page, key);
    if (!hasLikelyField) {
      return false;
    }
    const ocrFilled = await fillFieldByOcr(page, key, value, osInput);
    if (ocrFilled) {
      return true;
    }
  }
  return false;
}

async function hasPotentialFieldInContext(context: FillContext, key: string): Promise<boolean> {
  const normalizedKey = key.trim();
  if (normalizedKey.toLowerCase() === "full_name") {
    const nameSelectors = [
      `input[name="legalName--firstName"]`,
      `input[id="name--legalName--firstName"]`,
      `input[name*="firstName" i]`,
      `input[id*="firstName" i]`,
      `input[autocomplete="given-name"]`,
      `input[name="legalName--lastName"]`,
      `input[id="name--legalName--lastName"]`,
      `input[name*="lastName" i]`,
      `input[id*="lastName" i]`,
      `input[autocomplete="family-name"]`
    ];
    for (const selector of nameSelectors) {
      const count = await context.locator(selector).count().catch(() => 0);
      if (count > 0) {
        return true;
      }
    }
  }
  if (normalizedKey.toLowerCase() === "phone") {
    const phoneSelectors = [
      `input[name="phoneNumber"]`,
      `input[id="phoneNumber"]`,
      `input[id*="phoneNumber" i]:not([id*="extension" i])`,
      `input[name*="phoneNumber" i]:not([name*="extension" i])`,
      `input[type="tel"]`,
      `input[autocomplete="tel"]`,
      `input[aria-label*="phone number" i]:not([aria-label*="extension" i])`,
      `input[placeholder*="phone number" i]:not([placeholder*="extension" i])`
    ];
    for (const selector of phoneSelectors) {
      const count = await context.locator(selector).count().catch(() => 0);
      if (count > 0) {
        return true;
      }
    }
    const byLabelCount = await context.getByLabel(/^(?!.*extension).*phone(?: number)?/i).count().catch(() => 0);
    if (byLabelCount > 0) {
      return true;
    }
  }
  if (normalizedKey.toLowerCase() === "location") {
    const locationSelectors = [
      `input[name="city"]`,
      `input[id="city"]`,
      `input[id*="city" i]`,
      `input[name*="city" i]`,
      `input[aria-label*="city" i]`,
      `input[placeholder*="city" i]`,
      `input[name="location"]`,
      `input[id="location"]`
    ];
    for (const selector of locationSelectors) {
      const count = await context.locator(selector).count().catch(() => 0);
      if (count > 0) {
        return true;
      }
    }
    const byLabelCount = await context.getByLabel(/\bcity\b|\blocation\b/i).count().catch(() => 0);
    if (byLabelCount > 0) {
      return true;
    }
  }
  const directSelectors = [
    `input[name="${escapeCssAttributeValue(normalizedKey)}"]`,
    `textarea[name="${escapeCssAttributeValue(normalizedKey)}"]`,
    `select[name="${escapeCssAttributeValue(normalizedKey)}"]`,
    `input[id="${escapeCssAttributeValue(normalizedKey)}"]`,
    `textarea[id="${escapeCssAttributeValue(normalizedKey)}"]`,
    `select[id="${escapeCssAttributeValue(normalizedKey)}"]`
  ];

  for (const selector of directSelectors) {
    const count = await context.locator(selector).count().catch(() => 0);
    if (count > 0) {
      return true;
    }
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
      `textarea[placeholder*="${safeToken}" i]`,
      `select[placeholder*="${safeToken}" i]`,
      `input[data-automation-id*="${safeToken}" i]`,
      `textarea[data-automation-id*="${safeToken}" i]`,
      `select[data-automation-id*="${safeToken}" i]`
    ];
    for (const selector of tokenSelectors) {
      const count = await context.locator(selector).count().catch(() => 0);
      if (count > 0) {
        return true;
      }
    }

    const tokenPattern = new RegExp(escapeRegExp(token), "i");
    const byLabelCount = await context.getByLabel(tokenPattern).count().catch(() => 0);
    if (byLabelCount > 0) {
      return true;
    }
  }
  return false;
}

async function hasPotentialField(page: Page, key: string): Promise<boolean> {
  for (const ref of collectFillContexts(page)) {
    const present = await hasPotentialFieldInContext(ref.context, key);
    if (present) {
      return true;
    }
  }
  return false;
}

async function fillRoleSpecificPromptsInContext(context: FillContext, prompts: string[], osInput?: WindowsOsInputDriver): Promise<number> {
  if (prompts.length === 0) {
    return 0;
  }
  const fields = context.locator("textarea, input[type='text']");
  const count = await fields.count().catch(() => 0);
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
      const root = ((element as any).closest?.("[data-automation-id^='formField-'], fieldset, [role='group']") ?? (element as any).parentElement) as any;
      const labels = Array.isArray((element as any).labels)
        ? ((element as any).labels as Array<{ textContent?: string }>).map((label) => label.textContent ?? "").join(" ").toLowerCase()
        : "";
      const promptText = String(root?.querySelector?.("legend")?.textContent ?? root?.textContent ?? "")
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase();
      const combined = `${attrs} ${labels} ${promptText}`.trim();
      if (/(weekly hours|hours per week|compensation expectations|salary|pay expectation|legally entitled|insurance license|politically exposed|ernst\s*&\s*young|relatives|personal relationship)/i.test(combined)) {
        return false;
      }
      if ((element as any).tagName?.toLowerCase?.() === "textarea") {
        return /(cover|motivation|why|message|summary|tell us|interest|additional information)/i.test(combined);
      }
      return /(cover|motivation|why|message|summary|tell us|interest)/i.test(combined);
    }).catch(() => false);
    if (!isRolePrompt) {
      continue;
    }
    const applied = await tryFillLocator(field, prompts[used], osInput);
    const filled = applied ? await field.inputValue().catch(() => "") : "";
    if (filled.trim().length > 0) {
      used += 1;
    }
  }
  return used;
}

async function fillRoleSpecificPrompts(page: Page, prompts: string[], osInput?: WindowsOsInputDriver): Promise<number> {
  let used = 0;
  for (const ref of collectFillContexts(page)) {
    if (used >= prompts.length) {
      break;
    }
    const consumed = await fillRoleSpecificPromptsInContext(
      ref.context,
      prompts.slice(used),
      ref.allowOsInput ? osInput : undefined
    );
    used += consumed;
  }
  return used;
}

async function uploadResumeToContext(context: FillContext, resumePath: string): Promise<boolean> {
  const prioritizedSelectors = [
    "input[type='file'][name*='resume' i]",
    "input[type='file'][id*='resume' i]",
    "input[type='file'][aria-label*='resume' i]",
    "input[type='file'][name*='cv' i]",
    "input[type='file'][id*='cv' i]",
    "input[type='file'][aria-label*='cv' i]"
  ];
  for (const selector of prioritizedSelectors) {
    const locator = context.locator(selector);
    const count = await locator.count().catch(() => 0);
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

  const anyFileInputs = context.locator("input[type='file']");
  const total = await anyFileInputs.count().catch(() => 0);
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

async function uploadResumeViaFileChooser(page: Page, resumePath: string): Promise<boolean> {
  const chooserSelectors = [
    "button:has-text('Upload resume')",
    "button:has-text('Upload Resume')",
    "button:has-text('Upload CV')",
    "button:has-text('Attach Resume')",
    "button:has-text('Attach CV')",
    "label:has-text('Upload resume')",
    "label:has-text('Upload Resume')",
    "label:has-text('Upload CV')"
  ];

  for (const ref of collectFillContexts(page)) {
    const context = ref.context;
    for (const selector of chooserSelectors) {
      const locator = context.locator(selector);
      const count = await locator.count().catch(() => 0);
      const attempts = Math.min(3, count);
      for (let index = 0; index < attempts; index += 1) {
        const trigger = locator.nth(index);
        if (await trigger.isDisabled().catch(() => false)) {
          continue;
        }
        const chooserPromise = page.waitForEvent("filechooser", { timeout: 2200 }).catch(() => null as any);
        await trigger.click({ timeout: 2200 }).catch(() => undefined);
        const chooser = await chooserPromise;
        if (chooser == null) {
          continue;
        }
        await chooser.setFiles(resumePath).catch(() => undefined);
        await waitForLightSettle(page);
        const uploaded = await page.locator("input[type='file']").evaluateAll((elements) => {
          return elements.some((element) => Number((element as any).files?.length ?? 0) > 0);
        }).catch(() => false);
        if (uploaded) {
          return true;
        }
      }
    }
  }
  return false;
}

async function uploadResumeToPage(page: Page, resumePath: string, osInput?: WindowsOsInputDriver): Promise<boolean> {
  const hasExistingResume = await page.evaluate(() => {
    const root = (globalThis as any).document as any;
    const explicitSignal = root?.querySelector?.(
      [
        "button[aria-label*='remove uploaded resume' i]",
        "button[aria-label*='remove resume' i]",
        "button[aria-label*='remove file' i]",
        "button[data-automation-id='delete-file']",
        "[data-automation-id='file-upload-successful']",
        "[data-automation-id='file-upload-item']",
        ".file-upload__filename",
        ".file-upload-item-name",
        "[class*='jobs-document-upload'][class*='filename']"
      ].join(", ")
    );
    if (explicitSignal != null) {
      return true;
    }
    const bodyText = String(root?.body?.textContent ?? "").replace(/\s+/g, " ").toLowerCase();
    return /uploaded resume|resume uploaded|current resume|selected resume|successfully uploaded|remove file|delete .*\.pdf/.test(bodyText);
  }).catch(() => false);
  if (hasExistingResume) {
    return true;
  }

  for (const ref of collectFillContexts(page)) {
    const uploaded = await uploadResumeToContext(ref.context, resumePath);
    if (uploaded) {
      return true;
    }
  }

  const openedUploadSurface = await clickAdaptiveCandidate(page, [
    "button:has-text('Upload resume')",
    "button:has-text('Upload Resume')",
    "button:has-text('Upload CV')",
    "button:has-text('Attach Resume')",
    "button:has-text('Attach CV')",
    "label:has-text('Upload resume')",
    "label:has-text('Upload Resume')",
    "label:has-text('Upload CV')",
    "span:has-text('Upload resume')",
    "span:has-text('Upload Resume')"
  ], [
    "upload resume",
    "upload cv",
    "attach resume",
    "attach cv",
    "resume"
  ], osInput, 8000, true, "light", osInput != null, true);

  if (!openedUploadSurface) {
    return false;
  }

  for (const ref of collectFillContexts(page)) {
    const uploaded = await uploadResumeToContext(ref.context, resumePath);
    if (uploaded) {
      return true;
    }
  }
  const chooserUploaded = await uploadResumeViaFileChooser(page, resumePath);
  if (chooserUploaded) {
    return true;
  }
  return await page.evaluate(() => {
    const root = (globalThis as any).document as any;
    return root?.querySelector?.(
      [
        "button[data-automation-id='delete-file']",
        "[data-automation-id='file-upload-successful']",
        "[data-automation-id='file-upload-item']"
      ].join(", ")
    ) != null;
  }).catch(() => false);
}

async function attemptApplicationSubmit(page: Page, osInput?: WindowsOsInputDriver): Promise<boolean> {
  const clicked = await clickFirstCandidate(page, [
    "button[type='submit']",
    "input[type='submit']",
    "button:has-text('Submit')",
    "button:has-text('Apply')",
    "button:has-text('Send application')",
    "button:has-text('Complete application')"
  ], osInput, 8000, true);
  if (!clicked) {
    return false;
  }
  await page.waitForLoadState("domcontentloaded", { timeout: 12000 }).catch(() => undefined);
  await page.waitForLoadState("networkidle", { timeout: 12000 }).catch(() => undefined);
  await page.waitForTimeout(2000).catch(() => undefined);
  const url = page.url().toLowerCase();
  if (/(thank|submitted|confirmation|complete)/i.test(url)) {
    return true;
  }
  const bodyText = ((await page.textContent("body").catch(() => "")) ?? "").toLowerCase();
  return /(application submitted|thank you for applying|thanks for applying|we have received your application|application has been received)/i.test(bodyText);
}

async function autofillApplication(
  page: Page,
  draft: ApplicationDraft,
  resumePath: string,
  additionalAnswers: Record<string, string>,
  osInput?: WindowsOsInputDriver
): Promise<{
  filledKeys: string[];
  missingKeys: string[];
  candidateKeys: string[];
  roleAnswersUsed: number;
  resumeUploaded: boolean;
}> {
  const mergedAnswers: Record<string, string> = {
    ...draft.answers,
    ...additionalAnswers
  };
  const filledKeys: string[] = [];
  const missingKeys: string[] = [];
  const candidateKeys = new Set<string>();
  for (const [key, rawValue] of Object.entries(mergedAnswers)) {
    const value = String(rawValue ?? "").trim();
    if (value.length === 0) {
      continue;
    }
    const filled = await fillDraftField(page, key, value, osInput);
    if (!filled) {
      if (await hasPotentialField(page, key)) {
        missingKeys.push(key);
        candidateKeys.add(key);
      }
    } else {
      filledKeys.push(key);
      candidateKeys.add(key);
    }
  }
  const roleAnswersUsed = await fillRoleSpecificPrompts(page, draft.roleSpecificAnswers, osInput);
  const resumeUploaded = await uploadResumeToPage(page, resumePath, osInput);
  return {
    filledKeys,
    missingKeys,
    candidateKeys: Array.from(candidateKeys),
    roleAnswersUsed,
    resumeUploaded
  };
}

async function inspectVisibleStepField(locator: Locator): Promise<Omit<VisibleStepField, "locator"> | null> {
  if (await locator.count().catch(() => 0) === 0) {
    return null;
  }
  if (await locator.isDisabled().catch(() => false)) {
    return null;
  }
  const tagName = await locator.evaluate((element) => String((element as any).tagName ?? "").toLowerCase()).catch(() => "");
  const inputType = ((await locator.getAttribute("type")) ?? "").toLowerCase();
  const directlyVisible = await locator.isVisible().catch(() => false);
  if (!directlyVisible) {
    const actionableChoiceProxy = tagName === "input" && (inputType === "checkbox" || inputType === "radio")
      ? await locator.evaluate((element) => {
          const el = element as any;
          const root = (
            el.closest?.("[data-automation-id^='formField-']")
            ?? el.closest?.("fieldset")
            ?? el.closest?.("[role='group']")
            ?? el.closest?.(".css-1utp272")
            ?? el.closest?.(".css-d3pjdr")
            ?? el.closest?.("label")
            ?? el.parentElement
          ) as any;
          if (root == null) {
            return false;
          }
          const rect = root.getBoundingClientRect?.();
          if (rect == null || rect.width < 2 || rect.height < 2) {
            return false;
          }
          const style = (globalThis as any).getComputedStyle?.(root);
          if (style != null && (style.visibility === "hidden" || style.display === "none")) {
            return false;
          }
          return true;
        }).catch(() => false)
      : false;
    if (!actionableChoiceProxy) {
      return null;
    }
  }
  const metadata = await locator.evaluate((element) => {
    const el = element as any;
    const root = (
      el.closest?.(".select-shell")
      ?? el.closest?.(".select")
      ?? el.closest?.(".field-wrapper")
      ?? el.closest?.("[data-automation-id^='formField-']")
      ?? el.closest?.("fieldset")
      ?? el.closest?.("[role='group']")
      ?? el.parentElement
    ) as any;
    const tag = String(el.tagName ?? "").toLowerCase();
    const type = String(el.getAttribute("type") ?? "").toLowerCase();
    const ariaHasPopup = String(el.getAttribute("aria-haspopup") ?? "").toLowerCase();
    const ariaHidden = String(el.getAttribute("aria-hidden") ?? "").toLowerCase() === "true";
    const tabIndex = String(el.getAttribute("tabindex") ?? "");
    const className = String(el.getAttribute("class") ?? "");
    const name = String(el.getAttribute("name") ?? "");
    const id = String(el.getAttribute("id") ?? "");
    const value = "value" in el ? String((el as any).value ?? "").trim() : "";
    const buttonText = String(el.textContent ?? "").replace(/\s+/g, " ").trim();
    const checked = "checked" in el ? Boolean((el as any).checked) : false;
    const required = Boolean((el as any).required)
      || String(el.getAttribute("aria-required") ?? "").toLowerCase() === "true"
      || String(root?.getAttribute?.("aria-required") ?? "").toLowerCase() === "true";
    const labelText = Array.from((el as any).labels ?? [])
      .map((label: any) => (label?.textContent ?? "").replace(/\s+/g, " ").trim())
      .filter((entry: string) => entry.length > 0)
      .join(" ");
    const labeledByIds = [
      String(el.getAttribute("aria-labelledby") ?? ""),
      String(root?.getAttribute?.("aria-labelledby") ?? "")
    ].join(" ").trim().split(/\s+/).filter((entry: string) => entry.length > 0);
    const labelledByText = labeledByIds
      .map((entry: string) => (el.ownerDocument?.getElementById?.(entry)?.textContent ?? "").replace(/\s+/g, " ").trim())
      .filter((entry: string) => entry.length > 0)
      .join(" ");
    const legendText = String(root?.querySelector?.("legend")?.textContent ?? "").replace(/\s+/g, " ").trim();
    const groupLabels = Array.from(root?.querySelectorAll?.("label") ?? [])
      .map((label: any) => String(label?.textContent ?? "").replace(/\s+/g, " ").trim())
      .filter((entry: string) => entry.length > 0);
    const selectedItemText = Array.from(root?.querySelectorAll?.("[data-automation-id='selectedItem'], [data-automation-id='promptOption']") ?? [])
      .map((node: any) => String(node?.textContent ?? "").replace(/\s+/g, " ").trim())
      .filter((entry: string) => entry.length > 0)
      .join(" ");
    const nativeSelectedText = tag === "select"
      ? Array.from((el as any).selectedOptions ?? [])
        .map((option: any) => String(option?.textContent ?? "").replace(/\s+/g, " ").trim())
        .filter((entry: string) => entry.length > 0)
        .join(" ")
      : "";
    const customSelectedText = [
      String(root?.querySelector?.(".select__single-value")?.textContent ?? ""),
      String(root?.querySelector?.("#aria-selection")?.textContent ?? "")
    ].map((entry) => entry.replace(/\s+/g, " ").trim()).filter((entry) => entry.length > 0).join(" ");
    const proxyRequiredValue = String(root?.querySelector?.("input[aria-hidden='true'][tabindex='-1']")?.value ?? "").trim();
    const groupPrompt = [
      legendText,
      labelledByText,
      String(el.getAttribute("aria-label") ?? ""),
      String(el.getAttribute("placeholder") ?? ""),
      name.replace(/[_-]+/g, " "),
      id.replace(/[_-]+/g, " ")
    ].map((entry) => entry.trim()).filter((entry) => entry.length > 0).join(" ").replace(/\s+/g, " ").trim();
    const prompt = type === "checkbox" || type === "radio"
      ? groupPrompt
      : [
          groupPrompt,
          labelText
        ].map((entry) => entry.trim()).filter((entry) => entry.length > 0).join(" ").replace(/\s+/g, " ").trim();
    const optionLabels = tag === "select"
      ? Array.from((el as any).options ?? [])
        .map((option: any) => String(option?.textContent ?? "").replace(/\s+/g, " ").trim())
        .filter((entry) => entry.length > 0)
      : (type === "checkbox" || type === "radio")
        ? groupLabels
        : [];
    const isListboxButton = tag === "button" && ariaHasPopup === "listbox";
    const customSelectProxy = tag === "input"
      && (
        type === "text"
        || String(el.getAttribute("role") ?? "").toLowerCase() === "combobox"
      )
      && (
        root?.querySelector?.("button[aria-haspopup='listbox']") != null
        || root?.classList?.contains?.("select-shell")
        || root?.querySelector?.(".select__control") != null
        || String(el.getAttribute("role") ?? "").toLowerCase() === "combobox"
        || String(el.getAttribute("aria-autocomplete") ?? "").toLowerCase() === "list"
      );
    const hiddenRequiredProxy = tag === "input"
      && ariaHidden
      && (tabIndex === "-1" || /requiredinput/i.test(className));
    const normalizedButtonText = buttonText.toLowerCase();
    const buttonLooksEmpty = normalizedButtonText.length === 0
      || /^select\b/.test(normalizedButtonText)
      || /^choose\b/.test(normalizedButtonText)
      || /^please select\b/.test(normalizedButtonText);
    const groupChecked = (type === "radio" || type === "checkbox")
      ? Array.from(root?.querySelectorAll?.("input[type='radio'], input[type='checkbox']") ?? [])
        .some((input: any) => {
          const checked = Boolean(input?.checked);
          const ariaChecked = String(input?.getAttribute?.("aria-checked") ?? "").toLowerCase() === "true";
          return checked || ariaChecked;
        })
      : false;
    const empty = type === "checkbox" || type === "radio"
      ? !groupChecked
      : isListboxButton
        ? buttonLooksEmpty
        : customSelectProxy
          ? value.length === 0 && selectedItemText.length === 0 && customSelectedText.length === 0 && proxyRequiredValue.length === 0
          : value.length === 0 && selectedItemText.length === 0;
    const currentValue = type === "checkbox" || type === "radio"
      ? Array.from(root?.querySelectorAll?.("input[type='radio'], input[type='checkbox']") ?? [])
        .filter((input: any) => Boolean(input?.checked) || String(input?.getAttribute?.("aria-checked") ?? "").toLowerCase() === "true")
        .map((input: any) => {
          const inputId = String(input?.id ?? "").trim();
          const explicitLabel = inputId.length > 0
            ? root?.querySelector?.(`label[for="${inputId.replace(/"/g, "\\\"")}"]`)
            : null;
          const nestedLabel = input?.closest?.("label");
          return String(explicitLabel?.textContent ?? nestedLabel?.textContent ?? input?.value ?? "").replace(/\s+/g, " ").trim();
        })
        .filter((entry: string) => entry.length > 0)
        .join(" ")
      : isListboxButton
        ? [selectedItemText, customSelectedText, buttonLooksEmpty ? "" : buttonText, proxyRequiredValue]
          .find((entry) => entry.trim().length > 0) ?? ""
        : customSelectProxy
          ? [value, selectedItemText, customSelectedText, proxyRequiredValue]
            .find((entry) => entry.trim().length > 0) ?? ""
          : [nativeSelectedText, selectedItemText, value]
            .find((entry) => entry.trim().length > 0) ?? "";
    return {
      tag,
      type: isListboxButton ? "listbox" : (customSelectProxy ? "combobox" : type),
      required,
      prompt,
      optionLabels,
      currentValue,
      empty,
      customSelectProxy,
      hiddenRequiredProxy
    };
  }).catch(() => null as {
    tag: string;
    type: string;
    required: boolean;
    prompt: string;
    optionLabels: string[];
    currentValue: string;
    empty: boolean;
    customSelectProxy?: boolean;
    hiddenRequiredProxy?: boolean;
  } | null);
  if (metadata == null) {
    return null;
  }
  if (metadata.hiddenRequiredProxy) {
    return null;
  }
  if (metadata.type === "hidden" || metadata.type === "submit" || metadata.type === "file") {
    return null;
  }
  if (isAutofillTrapPrompt(metadata.prompt)) {
    return null;
  }
  if (metadata.tag === "button" && metadata.type !== "listbox") {
    return null;
  }
  if (metadata.prompt.length === 0) {
    return null;
  }
  if (/^phone country\b/i.test(metadata.prompt)) {
    return null;
  }
  return {
    prompt: metadata.prompt,
    tag: metadata.tag,
    type: metadata.type,
    required: metadata.required || metadata.prompt.includes("*"),
    optionLabels: metadata.optionLabels,
    currentValue: metadata.currentValue,
    empty: metadata.empty
  };
}

async function inspectVisibleChoiceGroup(locator: Locator): Promise<Omit<VisibleChoiceGroup, "fieldset"> | null> {
  if (await locator.count().catch(() => 0) === 0) {
    return null;
  }
  if (!await locator.isVisible().catch(() => false)) {
    return null;
  }
  const metadata = await locator.evaluate((element) => {
    const fieldset = element as any;
    const normalize = (value: unknown) => String(value ?? "").replace(/\s+/g, " ").trim();
    const options = Array.from(fieldset.querySelectorAll?.("input[type='checkbox'], input[type='radio']") ?? []) as any[];
    if (options.length === 0) {
      return null;
    }
    const optionLabels = options
      .map((input) => {
        const id = String(input?.id ?? "").trim();
        const explicitLabel = id.length > 0
          ? fieldset.querySelector?.(`label[for="${id.replace(/"/g, "\\\"")}"]`)
          : null;
        const nestedLabel = input.closest?.("label");
        return normalize(explicitLabel?.textContent ?? nestedLabel?.textContent ?? "");
      })
      .filter((entry) => entry.length > 0);
    const checked = options.some((input) => Boolean(input?.checked) || String(input?.getAttribute?.("aria-checked") ?? "").toLowerCase() === "true");
    const required = options.some((input) => {
      return Boolean(input?.required)
        || String(input?.getAttribute?.("aria-required") ?? "").toLowerCase() === "true";
    });
    const prompt = normalize(fieldset.querySelector?.("legend")?.textContent ?? fieldset.getAttribute?.("aria-label") ?? "");
    const type = options.some((input) => String(input?.type ?? "").toLowerCase() === "checkbox") ? "checkbox" : "radio";
    return {
      prompt,
      optionLabels,
      checked,
      required: required || prompt.includes("*"),
      type: type as "checkbox" | "radio"
    };
  }).catch(() => null as {
    prompt: string;
    optionLabels: string[];
    checked: boolean;
    required: boolean;
    type: "checkbox" | "radio";
  } | null);
  if (metadata == null) {
    return null;
  }
  if (metadata.checked) {
    return null;
  }
  if (metadata.prompt.length === 0 || metadata.optionLabels.length === 0) {
    return null;
  }
  if (isAutofillTrapPrompt(metadata.prompt)) {
    return null;
  }
  return metadata;
}

async function selectVisibleChoiceGroupOption(
  fieldset: Locator,
  answer: string,
  osInput?: WindowsOsInputDriver
): Promise<boolean> {
  const normalizedTargets = expandOptionTargets(answer).map((entry) => normalizePromptText(entry));
  const options = fieldset.locator("input[type='checkbox'], input[type='radio']");
  const count = await options.count().catch(() => 0);
  for (let index = 0; index < count; index += 1) {
    const option = options.nth(index);
    const optionLabel = await option.evaluate((element) => {
      const input = element as any;
      const normalize = (value: unknown) => String(value ?? "").replace(/\s+/g, " ").trim();
      const id = String(input?.id ?? "").trim();
      const explicitLabel = id.length > 0
        ? input.ownerDocument?.querySelector?.(`label[for="${id.replace(/"/g, "\\\"")}"]`)
        : null;
      const nestedLabel = input.closest?.("label");
      return normalize(explicitLabel?.textContent ?? nestedLabel?.textContent ?? input?.value ?? "");
    }).catch(() => "");
    const normalizedLabel = normalizePromptText(optionLabel);
    if (normalizedLabel.length === 0) {
      continue;
    }
    const matches = normalizedTargets.some((target) => {
      if (target.length === 0) {
        return false;
      }
      return normalizedLabel === target || normalizedLabel.includes(target) || target.includes(normalizedLabel);
    });
    if (!matches) {
      continue;
    }
    const clicked = await clickCheckboxLikeControl(option, osInput);
    if (clicked) {
      return true;
    }
  }
  return false;
}

async function fillVisibleStepFields(
  page: Page,
  draft: ApplicationDraft,
  additionalAnswers: Record<string, string>,
  osInput?: WindowsOsInputDriver
): Promise<VisibleStepFillResult> {
  const identity = resolveAutoApplyIdentity();
  const satisfiedPrompts = new Set<string>();
  const filledPrompts = new Set<string>();
  const unresolvedRequiredPrompts = new Set<string>();

  for (const ref of collectFillContexts(page)) {
    const fields = ref.context.locator("input, textarea, select, button[aria-haspopup='listbox']");
    const count = Math.min(await fields.count().catch(() => 0), 120);
    for (let index = 0; index < count; index += 1) {
      const locator = fields.nth(index);
      const metadata = await inspectVisibleStepField(locator);
      if (metadata == null) {
        continue;
      }
      if (satisfiedPrompts.has(metadata.prompt)) {
        continue;
      }
      const answer = inferAnswerForVisiblePrompt(metadata.prompt, metadata, draft, additionalAnswers, identity)
        ?? (metadata.required
          ? await inferAnswerWithLlm(metadata.prompt, metadata, draft, additionalAnswers, page)
          : null);
      if (answer == null) {
        if (metadata.required) {
          unresolvedRequiredPrompts.add(metadata.prompt);
        }
        continue;
      }
      if (!metadata.empty && doesFilledValueMatchTarget(metadata.currentValue, answer)) {
        satisfiedPrompts.add(metadata.prompt);
        unresolvedRequiredPrompts.delete(metadata.prompt);
        continue;
      }
      const filled = metadata.type === "listbox"
        ? await trySelectListboxButton(page, locator, answer, ref.allowOsInput ? osInput : undefined)
        : metadata.type === "combobox"
          ? await trySelectComboboxInput(page, locator, answer, ref.allowOsInput ? osInput : undefined)
          : await tryFillLocator(locator, answer, ref.allowOsInput ? osInput : undefined);
      if (filled) {
        satisfiedPrompts.add(metadata.prompt);
        filledPrompts.add(metadata.prompt);
        unresolvedRequiredPrompts.delete(metadata.prompt);
      } else if (metadata.required) {
        unresolvedRequiredPrompts.add(metadata.prompt);
      }
    }

    const fieldsets = ref.context.locator("fieldset");
    const fieldsetCount = Math.min(await fieldsets.count().catch(() => 0), 40);
    for (let index = 0; index < fieldsetCount; index += 1) {
      const fieldset = fieldsets.nth(index);
      const metadata = await inspectVisibleChoiceGroup(fieldset);
      if (metadata == null) {
        continue;
      }
      if (satisfiedPrompts.has(metadata.prompt)) {
        continue;
      }
      const answer = inferAnswerForVisiblePrompt(metadata.prompt, {
        tag: "input",
        type: metadata.type,
        optionLabels: metadata.optionLabels
      }, draft, additionalAnswers, identity)
        ?? (metadata.required
          ? await inferAnswerWithLlm(metadata.prompt, {
              tag: "input",
              type: metadata.type,
              optionLabels: metadata.optionLabels
            }, draft, additionalAnswers, page)
          : null);
      if (answer == null) {
        if (metadata.required) {
          unresolvedRequiredPrompts.add(metadata.prompt);
        }
        continue;
      }
      const filled = await selectVisibleChoiceGroupOption(fieldset, answer, ref.allowOsInput ? osInput : undefined);
      if (filled) {
        satisfiedPrompts.add(metadata.prompt);
        filledPrompts.add(metadata.prompt);
        unresolvedRequiredPrompts.delete(metadata.prompt);
      } else if (metadata.required) {
        unresolvedRequiredPrompts.add(metadata.prompt);
      }
    }
  }

  return {
    filledPrompts: Array.from(filledPrompts),
    unresolvedRequiredPrompts: Array.from(unresolvedRequiredPrompts)
  };
}

async function clickFirstCandidateInContext(
  context: FillContext,
  selectors: string[],
  osInput?: WindowsOsInputDriver,
  timeoutMs = 12000
): Promise<boolean> {
  for (const selector of selectors) {
    const locator = context.locator(selector).first();
    if (await locator.count().catch(() => 0) === 0) {
      continue;
    }
    if (!await locator.isVisible().catch(() => true)) {
      continue;
    }
    if (await locator.isDisabled().catch(() => false)) {
      continue;
    }
    const clicked = osInput != null
      ? await clickLocatorWithOsInput(locator, osInput).catch(() => false)
      : await locator.click({ timeout: timeoutMs }).then(() => true).catch(() => false);
    if (clicked) {
      return true;
    }
  }
  return false;
}

async function hasEnabledCandidateInContext(
  context: FillContext,
  selectors: string[]
): Promise<boolean> {
  for (const selector of selectors) {
    const locator = context.locator(selector).first();
    if (await locator.count().catch(() => 0) === 0) {
      continue;
    }
    if (!await locator.isVisible().catch(() => true)) {
      continue;
    }
    if (await locator.isDisabled().catch(() => false)) {
      continue;
    }
    return true;
  }
  return false;
}

function expandOptionTargets(value: string): string[] {
  const normalized = value.trim();
  const lower = normalized.toLowerCase();
  return unique([
    normalized,
    lower === "yes" ? "True" : "",
    lower === "yes" ? "I confirm" : "",
    lower === "yes" ? "Confirm" : "",
    lower === "no" ? "False" : "",
    lower === "full-time" ? "Full Time" : "",
    lower === "full time" ? "Full-Time" : ""
  ]).filter((entry) => entry.length > 0);
}

async function clickBestVisibleOption(
  page: Page,
  targets: string[],
  selectors = [
    "[role='option']",
    "[data-automation-id='promptOption']",
    "[data-automation-id='menuPanel'] [role='option']",
    "[data-automation-id='menuPanel'] button"
  ]
): Promise<boolean> {

  for (const target of targets) {
    const normalizedTarget = normalizePromptText(target);
    for (const selector of selectors) {
      const options = page.locator(selector);
      const count = Math.min(await options.count().catch(() => 0), 40);
      let bestIndex = -1;
      let bestScore = -1;
      for (let index = 0; index < count; index += 1) {
        const option = options.nth(index);
        if (!await option.isVisible().catch(() => false)) {
          continue;
        }
        const text = normalizePromptText(await option.innerText().catch(() => ""));
        if (text.length === 0) {
          continue;
        }
        let score = -1;
        if (text === normalizedTarget) {
          score = 100;
        } else if (text.startsWith(normalizedTarget)) {
          score = 80;
        } else if (text.includes(normalizedTarget) || normalizedTarget.includes(text)) {
          score = 60;
        }
        if (score > bestScore) {
          bestScore = score;
          bestIndex = index;
        }
      }
      if (bestIndex < 0) {
        continue;
      }
      const option = options.nth(bestIndex);
      const clicked = await option.click({ timeout: 5000 }).then(() => true).catch(() => false);
      if (clicked) {
        return true;
      }
    }
  }

  return false;
}

async function readComboboxSelectionState(locator: Locator): Promise<{
  inputValue: string;
  selectedText: string;
  singleValueText: string;
  ariaSelectionText: string;
  proxyValue: string;
  placeholder: string;
  containerValue: string;
  expanded: boolean;
  reactSelectLike: boolean;
}> {
  return locator.first().evaluate((element) => {
    const el = element as any;
    const root = (
      el.closest?.(".select-shell")
      ?? el.closest?.(".select")
      ?? el.closest?.(".field-wrapper")
      ?? el.parentElement
    ) as any;
    const normalize = (value: unknown) => String(value ?? "").replace(/\s+/g, " ").trim();
    const singleValueText = normalize(root?.querySelector?.(".select__single-value")?.textContent);
    const ariaSelectionText = normalize(root?.querySelector?.("#aria-selection")?.textContent);
    return {
      inputValue: "value" in el ? normalize((el as any).value) : normalize(el.textContent),
      selectedText: [
        singleValueText,
        ariaSelectionText,
        normalize(root?.querySelector?.("[data-automation-id='selectedItem']")?.textContent)
      ].find((entry) => entry.length > 0) ?? "",
      singleValueText,
      ariaSelectionText,
      proxyValue: normalize(root?.querySelector?.("input[aria-hidden='true'][tabindex='-1']")?.value),
      placeholder: normalize(root?.querySelector?.(".select__placeholder")?.textContent),
      containerValue: normalize(root?.querySelector?.(".select__input-container")?.getAttribute?.("data-value")),
      expanded: String(el.getAttribute?.("aria-expanded") ?? "").toLowerCase() === "true",
      reactSelectLike: Boolean(
        root?.classList?.contains?.("select-shell")
        || root?.querySelector?.(".select__control")
        || root?.querySelector?.(".select__single-value")
      )
    };
  }).catch(() => ({
    inputValue: "",
    selectedText: "",
    singleValueText: "",
    ariaSelectionText: "",
    proxyValue: "",
    placeholder: "",
    containerValue: "",
    expanded: false,
    reactSelectLike: false
  }));
}

function isCommittedComboboxSelection(
  state: {
    inputValue: string;
    selectedText: string;
    singleValueText: string;
    ariaSelectionText: string;
    proxyValue: string;
    placeholder: string;
    containerValue: string;
    expanded: boolean;
    reactSelectLike: boolean;
  },
  target: string
): boolean {
  const normalizedTarget = normalizePromptText(target);
  const normalizedPlaceholder = normalizePromptText(state.placeholder);
  const selectedValue = [state.selectedText, state.proxyValue, state.containerValue]
    .map((entry) => normalizePromptText(entry))
    .find((entry) => entry.length > 0) ?? "";
  if (selectedValue.length === 0) {
    if (state.reactSelectLike) {
      return false;
    }
    const normalizedInputValue = normalizePromptText(state.inputValue);
    if (normalizedInputValue.length === 0) {
      return false;
    }
    return normalizedInputValue.includes(normalizedTarget)
      || normalizedTarget.includes(normalizedInputValue);
  }
  if (state.reactSelectLike && state.singleValueText.trim().length === 0) {
    return false;
  }
  if (normalizedPlaceholder.length > 0 && selectedValue === normalizedPlaceholder) {
    return false;
  }
  if (state.selectedText.trim().length > 0 || state.proxyValue.trim().length > 0) {
    return selectedValue.includes(normalizedTarget) || normalizedTarget.includes(selectedValue) || normalizedTarget.length === 0;
  }
  return false;
}

async function blurComboboxField(page: Page, locator: Locator): Promise<void> {
  await locator.first().evaluate((element) => {
    (element as { blur?: () => void } | null)?.blur?.();
  }).catch(() => undefined);
  await page.locator("body").click({ position: { x: 10, y: 10 }, timeout: 2000 }).catch(() => undefined);
  await sleep(120);
}

async function trySelectComboboxInput(
  page: Page,
  locator: Locator,
  value: string,
  osInput?: WindowsOsInputDriver
): Promise<boolean> {
  const field = locator.first();
  if (await field.count().catch(() => 0) === 0) {
    return false;
  }
  if (!await field.isVisible().catch(() => false)) {
    return false;
  }
  if (await field.isDisabled().catch(() => false)) {
    return false;
  }

  const focusAcquired = osInput != null
    ? await clickLocatorWithOsInput(field, osInput).catch(() => false)
    : await field.click({ timeout: 8000 }).then(() => true).catch(() => false);
  if (!focusAcquired) {
    return false;
  }
  await sleep(120);

  if (osInput != null) {
    try {
      const domFocused = await isLocatorDomFocused(field);
      if (domFocused) {
        await osInput.sendKeys("^a");
        await sleep(40);
        await osInput.sendKeys("{BACKSPACE}");
        await sleep(40);
        await osInput.typeText(value);
      } else {
        await field.fill("").catch(() => undefined);
        await field.type(value, { delay: 25 }).catch(() => undefined);
      }
    } catch {
      await field.fill("").catch(() => undefined);
      await field.type(value, { delay: 25 }).catch(() => undefined);
    }
  } else {
    await field.fill("").catch(() => undefined);
    await field.type(value, { delay: 25 }).catch(() => undefined);
  }

  await sleep(250);
  const targets = expandOptionTargets(value);
  const fieldId = (await field.getAttribute("id"))?.trim() ?? "";
  const controlsId = (await field.getAttribute("aria-controls"))?.trim() ?? "";
  const targetedSelectors = unique([
    controlsId.length > 0 ? `#${controlsId} [role='option']` : "",
    fieldId.length > 0 ? `#react-select-${fieldId}-listbox [role='option']` : "",
    fieldId.length > 0 ? `[id^='react-select-${fieldId}-option-'][role='option']` : ""
  ]).filter((entry) => entry.length > 0);
  const initialState = await readComboboxSelectionState(field);
  const reactSelectLike = initialState.reactSelectLike || targetedSelectors.length > 0;

  let selected = targetedSelectors.length > 0
    ? await clickBestVisibleOption(page, targets, targetedSelectors)
    : false;
  if (!selected && !reactSelectLike) {
    selected = await clickBestVisibleOption(page, targets);
  }
  if (!selected) {
    await page.keyboard.press("ArrowDown").catch(() => undefined);
    await sleep(120);
    if (targetedSelectors.length > 0) {
      selected = await clickBestVisibleOption(page, targets, targetedSelectors);
    }
    if (!selected && !reactSelectLike) {
      selected = await clickBestVisibleOption(page, targets);
    }
  }
  if (!selected) {
    await blurComboboxField(page, field);
    return false;
  }
  await sleep(120);
  let state = await readComboboxSelectionState(field);
  if (!isCommittedComboboxSelection(state, value)) {
    await blurComboboxField(page, field);
    await waitForLightSettle(page);
    state = await readComboboxSelectionState(field);
  } else {
    await blurComboboxField(page, field);
    await waitForLightSettle(page);
    state = await readComboboxSelectionState(field);
  }
  if (isCommittedComboboxSelection(state, value)) {
    return true;
  }

  const openedByToggle = await field.evaluate((element) => {
    const el = element as any;
    const root = (
      el.closest?.(".select-shell")
      ?? el.closest?.(".select")
      ?? el.closest?.(".field-wrapper")
      ?? el.parentElement
    ) as any;
    const button = root?.querySelector?.("button[aria-label*='toggle' i], button[aria-haspopup='listbox']");
    if (button == null) {
      return false;
    }
    (button as any).click?.();
    return true;
  }).catch(() => false);
  if (!openedByToggle) {
    return false;
  }

  await sleep(120);
  await field.fill("").catch(() => undefined);
  await field.type(value, { delay: 25 }).catch(() => undefined);
  await sleep(250);
  selected = targetedSelectors.length > 0
    ? await clickBestVisibleOption(page, targets, targetedSelectors)
    : false;
  if (!selected && !reactSelectLike) {
    selected = await clickBestVisibleOption(page, targets);
  }
  if (!selected) {
    await page.keyboard.press("ArrowDown").catch(() => undefined);
    await sleep(120);
    if (targetedSelectors.length > 0) {
      selected = await clickBestVisibleOption(page, targets, targetedSelectors);
    }
    if (!selected && !reactSelectLike) {
      selected = await clickBestVisibleOption(page, targets);
    }
  }
  if (!selected) {
    await page.keyboard.press("Escape").catch(() => undefined);
    await blurComboboxField(page, field);
    return false;
  }
  await sleep(120);
  state = await readComboboxSelectionState(field);
  await blurComboboxField(page, field);
  await waitForLightSettle(page);
  state = await readComboboxSelectionState(field);
  if (!isCommittedComboboxSelection(state, value)) {
    await page.keyboard.press("Escape").catch(() => undefined);
    await blurComboboxField(page, field);
    return false;
  }
  return true;
}

async function trySelectListboxButton(
  page: Page,
  locator: Locator,
  value: string,
  osInput?: WindowsOsInputDriver
): Promise<boolean> {
  const field = locator.first();
  const beforeText = await field.innerText().catch(() => "");
  const opened = osInput != null
    ? await clickLocatorWithOsInput(field, osInput).catch(() => false)
    : await field.click({ timeout: 8000 }).then(() => true).catch(() => false);
  if (!opened) {
    return false;
  }
  await sleep(150);

  const targets = expandOptionTargets(value);
  const selected = await clickBestVisibleOption(page, targets);
  if (selected) {
    await waitForLightSettle(page);
    const afterText = await field.innerText().catch(() => "");
    const normalizedAfter = normalizePromptText(afterText);
    if (normalizedAfter.length > 0 && !/^select\b|^choose\b|^please select\b/i.test(normalizedAfter)) {
      return true;
    }
  }

  await page.keyboard.type(value, { delay: 30 }).catch(() => undefined);
  await page.keyboard.press("Enter").catch(() => undefined);
  await waitForLightSettle(page);
  const afterText = await field.innerText().catch(() => "");
  const normalizedAfter = normalizePromptText(afterText);
  const normalizedBefore = normalizePromptText(beforeText);
  return normalizedAfter.length > 0
    && !/^select\b|^choose\b|^please select\b/i.test(normalizedAfter)
    && normalizedAfter !== normalizedBefore;
}

async function clickFirstCandidate(
  page: Page,
  selectors: string[],
  osInput?: WindowsOsInputDriver,
  timeoutMs = 12000,
  includeFrames = false,
  settleMode: "full" | "light" = "full"
): Promise<boolean> {
  const contexts = includeFrames
    ? collectFillContexts(page)
    : [{ context: page, allowOsInput: true } as FillContextRef];
  for (const ref of contexts) {
    const clicked = await clickFirstCandidateInContext(
      ref.context,
      selectors,
      ref.allowOsInput ? osInput : undefined,
      timeoutMs
    );
    if (!clicked) {
      continue;
    }
    if (settleMode === "light") {
      await waitForLightSettle(page);
    } else {
      await waitForPageSettle(page);
    }
    return true;
  }
  return false;
}

async function hasAnySelectorCandidate(
  page: Page,
  selectors: string[],
  includeFrames = false
): Promise<boolean> {
  const contexts = includeFrames
    ? collectFillContexts(page)
    : [{ context: page, allowOsInput: true } as FillContextRef];
  for (const ref of contexts) {
    for (const selector of selectors) {
      const count = await ref.context.locator(selector).count().catch(() => 0);
      if (count > 0) {
        return true;
      }
    }
  }
  return false;
}

async function clickSelectorsPlaywrightFirst(
  page: Page,
  selectors: string[],
  timeoutMs = 10000,
  includeFrames = false
): Promise<boolean> {
  const contexts = includeFrames
    ? collectFillContexts(page)
    : [{ context: page, allowOsInput: true } as FillContextRef];
  for (const ref of contexts) {
    for (const selector of selectors) {
      const locator = ref.context.locator(selector).first();
      if (await locator.count().catch(() => 0) === 0) {
        continue;
      }
      if (await locator.isDisabled().catch(() => false)) {
        continue;
      }
      const clicked = await locator.click({ timeout: timeoutMs }).then(() => true).catch(() => false);
      if (clicked) {
        await waitForPageSettle(page);
        return true;
      }
    }
  }
  return false;
}

async function settleAfterPrimaryClick(context: BrowserContext, page: Page, timeoutMs = 15000): Promise<Page> {
  const popupPromise = context.waitForEvent("page", { timeout: timeoutMs })
    .then(async (popup) => {
      await popup.waitForLoadState("domcontentloaded", { timeout: timeoutMs }).catch(() => undefined);
      await popup.waitForLoadState("networkidle", { timeout: timeoutMs }).catch(() => undefined);
      return popup;
    })
    .catch(() => null as Page | null);

  const navigationPromise = page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: timeoutMs })
    .then(async () => {
      await waitForPageSettle(page);
      return page;
    })
    .catch(() => null as Page | null);

  const popup = await popupPromise;
  if (popup != null) {
    return popup;
  }
  const navigated = await navigationPromise;
  return navigated ?? page;
}

async function openWorkflowPage(context: BrowserContext, targetUrl: string): Promise<Page> {
  const page = await context.newPage();
  await openApplyPage(page, targetUrl);
  await assertPostingAvailable(page);
  return page;
}

function mergedAnswerKeys(draft: ApplicationDraft, additionalAnswers: Record<string, string>): string[] {
  return Object.entries({ ...draft.answers, ...additionalAnswers })
    .filter(([, rawValue]) => String(rawValue ?? "").trim().length > 0)
    .map(([key]) => key);
}

function isLinkedInCollectionsUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return /\/jobs\/collections\//i.test(parsed.pathname);
  } catch {
    return /linkedin\.com\/jobs\/collections\//i.test(url);
  }
}

function isLinkedInFeedUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return /(^|\.)linkedin\.com$/i.test(parsed.hostname) && /^\/feed\/?/i.test(parsed.pathname);
  } catch {
    return /linkedin\.com\/feed\/?/i.test(url);
  }
}

async function hasLinkedInEasyApplySurface(page: Page): Promise<boolean> {
  if (isLinkedInCollectionsUrl(page.url()) || isLinkedInFeedUrl(page.url())) {
    return false;
  }
  const modalControlCount = await page.locator(
    "div[role='dialog'] button:has-text('Next'), div[role='dialog'] button:has-text('Review'), div[role='dialog'] button:has-text('Continue'), div[role='dialog'] button:has-text('Submit application'), div[role='dialog'] button:has-text('Submit')"
  ).count().catch(() => 0);
  if (modalControlCount > 0) {
    return true;
  }
  const modalFieldCount = await page.locator(
    "div[role='dialog'] input, div[role='dialog'] textarea, div[role='dialog'] select"
  ).count().catch(() => 0);
  if (modalFieldCount > 0) {
    return true;
  }

  const surface = await analyzeApplicationSurface(page).catch(() => null as ApplicationSurfaceState | null);
  if (surface == null) {
    return false;
  }
  return surface.mainControls >= 3 && surface.mainForms >= 1 && !surface.hasLinkedInApplyEntry;
}

async function recoverLinkedInListingPage(page: Page, targetUrl: string): Promise<void> {
  if (!isLinkedInCollectionsUrl(page.url()) && !isLinkedInFeedUrl(page.url())) {
    return;
  }
  await openApplyPage(page, targetUrl).catch(() => undefined);
}

async function clickLinkedInEntryCandidate(
  page: Page,
  candidate: ResolvedLinkedInEntryCandidate,
  osInput?: WindowsOsInputDriver,
  _settleMode: "full" | "light" = "full"
): Promise<boolean> {
  if (!Number.isFinite(candidate.x) || !Number.isFinite(candidate.y)) {
    return false;
  }
  await page.bringToFront().catch(() => undefined);
  await page.evaluate(() => {
    const browserWindow = globalThis as any;
    browserWindow.focus?.();
  }).catch(() => undefined);

  const clicked = osInput != null
    ? await (async () => {
      const metrics = await getBrowserWindowMetrics(page);
      if (metrics == null) {
        return false;
      }
      const titleHint = await page.title().catch(() => "LinkedIn");
      await osInput.activateWindow(titleHint).catch(() => undefined);
      return osInput.clickViewportPoint(candidate.x, candidate.y, metrics.deviceScaleFactor)
        .then(() => true)
        .catch(() => false);
    })()
    : await page.mouse.click(candidate.x, candidate.y, { delay: 40 }).then(() => true).catch(() => false);

  if (!clicked) {
    return false;
  }
  await sleep(100);
  return true;
}

async function isLinkedInEntryStillVisible(
  page: Page,
  targetUrl: string,
  preferredKind?: LinkedInEntryKind
): Promise<boolean> {
  if (!isLinkedInUrl(page.url()) || page.url() !== targetUrl) {
    return false;
  }
  return getLinkedInPrimaryEntryCandidate(page, preferredKind)
    .then((candidate) => candidate != null)
    .catch(() => false);
}

async function retryLinkedInEntryWithPlaywright(
  context: BrowserContext,
  page: Page,
  preferredKind: LinkedInEntryKind,
  osInput?: WindowsOsInputDriver
): Promise<Page | null> {
  const candidate = await getLinkedInPrimaryEntryCandidate(page, preferredKind);
  if (candidate == null) {
    return null;
  }
  const clicked = await clickLinkedInEntryCandidate(page, candidate, undefined);
  if (!clicked) {
    return null;
  }
  const nextPage = await settleAfterPrimaryClick(context, page);
  return nextPage;
}

async function resolveExternalCompanyEntry(
  context: BrowserContext,
  startPage: Page,
  osInput?: WindowsOsInputDriver
): Promise<ApplicationEntryResult> {
  if (isWorkdayUrl(startPage.url())) {
    return resolveWorkdayEntry(context, startPage, osInput);
  }
  if (isLeverUrl(startPage.url())) {
    return resolveLeverEntry(context, startPage, osInput);
  }
  if (isKnownAtsUrl(startPage.url())) {
    return resolveCompanySpecificEntry(context, startPage, osInput);
  }
  return resolveCompanySpecificEntry(context, startPage, osInput);
}

async function resolveLinkedInEntry(context: BrowserContext, startPage: Page, osInput?: WindowsOsInputDriver): Promise<ApplicationEntryResult> {
  let page = startPage;
  const targetUrl = startPage.url();

  for (let attempt = 0; attempt < 3; attempt += 1) {
    await assertPostingAvailable(page);
    const easyApplyCandidate = await getLinkedInPrimaryEntryCandidate(page, "easy_apply");
    if (easyApplyCandidate == null) {
      break;
    }
    const easyApplyClicked = await clickLinkedInEntryCandidate(page, easyApplyCandidate, osInput);
    if (!easyApplyClicked) {
      break;
    }
    page = await settleAfterPrimaryClick(context, page);
    if (osInput != null && await isLinkedInEntryStillVisible(page, targetUrl, "easy_apply")) {
      const retriedPage = await retryLinkedInEntryWithPlaywright(context, page, "easy_apply", osInput);
      if (retriedPage != null) {
        page = retriedPage;
      }
    }
    if (await hasLinkedInEasyApplySurface(page)) {
      return {
        page,
        route: "linkedin_easy_apply"
      };
    }
    await recoverLinkedInListingPage(page, targetUrl);
  }

  for (let attempt = 0; attempt < 2; attempt += 1) {
    await assertPostingAvailable(page);
    const applyCandidate = await getLinkedInPrimaryEntryCandidate(page, "apply");
    if (applyCandidate == null) {
      break;
    }
    const applyClicked = await clickLinkedInEntryCandidate(page, applyCandidate, osInput);
    if (!applyClicked) {
      break;
    }
    page = await settleAfterPrimaryClick(context, page);
    if (osInput != null && await isLinkedInEntryStillVisible(page, targetUrl, "apply")) {
      const retriedPage = await retryLinkedInEntryWithPlaywright(context, page, "apply", osInput);
      if (retriedPage != null) {
        page = retriedPage;
      }
    }
    if (isLinkedInCollectionsUrl(page.url()) || isLinkedInFeedUrl(page.url())) {
      await recoverLinkedInListingPage(page, targetUrl);
      continue;
    }
    if (isLinkedInUrl(page.url())) {
      const surface = await analyzeApplicationSurface(page);
      if (page.url() === targetUrl && !isApplicationSurfaceReady(page, surface)) {
        await openApplyPage(page, targetUrl).catch(() => undefined);
        continue;
      }
      if (!isApplicationSurfaceReady(page, surface) && surface.hasLinkedInApplyEntry) {
        await openApplyPage(page, targetUrl).catch(() => undefined);
        continue;
      }
    }
    if (!isLinkedInUrl(page.url())) {
      return resolveExternalCompanyEntry(context, page, osInput);
    }
    return {
      page,
      route: "linkedin_apply"
    };
  }

  if (!isLinkedInUrl(page.url())) {
    return resolveExternalCompanyEntry(context, page, osInput);
  }

  const fallbackSurface = await analyzeApplicationSurface(page);
  if (!isApplicationSurfaceReady(page, fallbackSurface)) {
    if (await getLinkedInPrimaryEntryCandidate(page) != null) {
      throw new Error("LinkedIn Apply/Easy Apply button was detected but could not be clicked safely without drifting.");
    }
    throw new Error("LinkedIn application surface was not detected after entry resolution.");
  }

  return {
    page,
    route: "linkedin_apply"
  };
}

async function resolveLeverEntry(context: BrowserContext, startPage: Page, osInput?: WindowsOsInputDriver): Promise<ApplicationEntryResult> {
  let page = startPage;
  const leverSelectors = [
    "a[href*='/apply']",
    "a[data-qa='show-page-apply']",
    "a:has-text('Apply for this job')",
    "button:has-text('Apply for this job')",
    "a:has-text('Apply')",
    "button:has-text('Apply')"
  ];

  for (let attempt = 0; attempt < 4; attempt += 1) {
    await assertPostingAvailable(page);
    const onApplyPage = /\/apply(?:$|[/?#])/i.test(page.url());
    const surface = await analyzeApplicationSurface(page);
    const hasEntryGate = await page.locator(
      "a[href*='/apply'], a[data-qa='show-page-apply'], a:has-text('Apply for this job'), button:has-text('Apply for this job')"
    ).count().then((count) => count > 0).catch(() => false);
    if ((onApplyPage && surface.mainControls >= 4) || (isApplicationSurfaceReady(page, surface) && !hasEntryGate)) {
      return {
        page,
        route: onApplyPage || attempt > 0 ? "generic_apply" : "direct_form"
      };
    }

    let clicked = false;
    if (attempt < 2) {
      clicked = await clickSelectorsPlaywrightFirst(page, leverSelectors, 10000, false);
    }
    if (!clicked) {
      clicked = await clickAdaptiveCandidate(page, leverSelectors, [
        "apply for this job",
        "apply"
      ], osInput, 10000, true, "full", osInput != null, true);
    }
    if (!clicked) {
      break;
    }
    page = await settleAfterPrimaryClick(context, page);
  }

  return {
    page,
    route: /\/apply(?:$|[/?#])/i.test(page.url()) ? "generic_apply" : "direct_form"
  };
}

async function resolveGenericEntry(context: BrowserContext, startPage: Page, osInput?: WindowsOsInputDriver): Promise<ApplicationEntryResult> {
  let page = startPage;
  const genericSelectors = [
    "button:has-text('Apply')",
    "a:has-text('Apply')",
    "button:has-text('Apply now')",
    "a:has-text('Apply now')",
    "button:has-text('Apply for this job')",
    "a:has-text('Apply for this job')",
    "button:has-text('Continue to application')",
    "a:has-text('Continue to application')",
    "button:has-text('Continue')",
    "a:has-text('Continue')",
    "button:has-text('Start application')",
    "a:has-text('Start application')",
    "button:has-text('View application')",
    "a:has-text('View application')",
    "button:has-text('Start Application')",
    "a:has-text('Start Application')"
  ];

  for (let attempt = 0; attempt < 4; attempt += 1) {
    await assertPostingAvailable(page);
    const surface = await analyzeApplicationSurface(page);
    const hasEntryGate = await page.locator(
      "button:has-text('Apply for this job'), a:has-text('Apply for this job'), button:has-text('Apply now'), a:has-text('Apply now'), button:has-text('Start application'), a:has-text('Start application')"
    ).count().then((count) => count > 0).catch(() => false);
    if (isApplicationSurfaceReady(page, surface) && !hasEntryGate) {
      return {
        page,
        route: attempt === 0 ? "direct_form" : "generic_apply"
      };
    }
    let clicked = await clickSelectorsPlaywrightFirst(page, genericSelectors, 10000, false);
    if (!clicked) {
      clicked = await clickAdaptiveCandidate(page, genericSelectors, [
        "apply",
        "start application",
        "continue",
        "next"
      ], osInput, 10000, true, "full", osInput != null, true);
    }
    if (!clicked) {
      break;
    }
    page = await settleAfterPrimaryClick(context, page);
  }

  return {
    page,
    route: "direct_form"
  };
}

async function resolveWorkdayEntry(context: BrowserContext, startPage: Page, osInput?: WindowsOsInputDriver): Promise<ApplicationEntryResult> {
  let page = startPage;
  const workdaySelectors = [
    "a[data-automation-id='applyManually']",
    "button[data-automation-id='applyManually']",
    "a:has-text('Apply Manually')",
    "button:has-text('Apply Manually')",
    "button[data-automation-id='applyButton']",
    "a[data-automation-id='applyButton']",
    "button[data-automation-id='utilityButtonSignIn']",
    "a[data-automation-id='utilityButtonSignIn']",
    "button:has-text('Apply')",
    "a:has-text('Apply')",
    "button:has-text('Apply Now')",
    "a:has-text('Apply Now')",
    "button:has-text('Start Application')",
    "a:has-text('Start Application')",
    "button:has-text('Sign In')",
    "a:has-text('Sign In')",
    "button:has-text('Continue')",
    "a:has-text('Continue')"
  ];

  for (let attempt = 0; attempt < 5; attempt += 1) {
    await assertPostingAvailable(page);
    const surface = await analyzeApplicationSurface(page);
    const hasEntryGate = await page.locator(
      "a[data-automation-id='applyManually'], button[data-automation-id='applyManually'], button[data-automation-id='applyButton'], a[data-automation-id='applyButton'], button[data-automation-id='utilityButtonSignIn'], a[data-automation-id='utilityButtonSignIn'], button:has-text('Apply'), a:has-text('Apply'), button:has-text('Start Application'), button:has-text('Sign In'), a:has-text('Sign In')"
    ).count().then((count) => count > 0).catch(() => false);
    if (isApplicationSurfaceReady(page, surface) && !hasEntryGate) {
      return {
        page,
        route: "workday"
      };
    }
    let clicked = await clickSelectorsPlaywrightFirst(page, workdaySelectors, 12000, false);
    if (!clicked) {
      clicked = await clickAdaptiveCandidate(page, workdaySelectors, [
        "apply manually",
        "apply",
        "apply now",
        "start application",
        "sign in",
        "continue"
      ], osInput, 12000, true, "full", osInput != null, true);
    }
    if (!clicked) {
      break;
    }
    page = await settleAfterPrimaryClick(context, page);
  }

  return {
    page,
    route: "workday"
  };
}

async function resolveCompanySpecificEntry(context: BrowserContext, startPage: Page, osInput?: WindowsOsInputDriver): Promise<ApplicationEntryResult> {
  let page = startPage;
  const companySelectors = [
    "button:has-text('Apply')",
    "a:has-text('Apply')",
    "button:has-text('Apply now')",
    "a:has-text('Apply now')",
    "button:has-text('Apply for this job')",
    "a:has-text('Apply for this job')",
    "button:has-text('Start application')",
    "a:has-text('Start application')",
    "button:has-text('Continue to application')",
    "a:has-text('Continue to application')",
    "button:has-text('Continue')",
    "a:has-text('Continue')",
    "button:has-text('Get started')",
    "a:has-text('Get started')"
  ];

  for (let attempt = 0; attempt < 5; attempt += 1) {
    await assertPostingAvailable(page);
    const surface = await analyzeApplicationSurface(page);
    const hasEntryGate = await page.locator(
      "button:has-text('Apply'), a:has-text('Apply'), button:has-text('Apply now'), a:has-text('Apply now'), button:has-text('Start application'), a:has-text('Start application')"
    ).count().then((count) => count > 0).catch(() => false);
    if (isApplicationSurfaceReady(page, surface) && !hasEntryGate) {
      return {
        page,
        route: "company_specific"
      };
    }
    let clicked = await clickSelectorsPlaywrightFirst(page, companySelectors, 12000, false);
    if (!clicked) {
      clicked = await clickAdaptiveCandidate(page, companySelectors, [
        "apply",
        "apply now",
        "start application",
        "continue to application",
        "continue",
        "next"
      ], osInput, 12000, true, "full", osInput != null, true);
    }
    if (!clicked) {
      break;
    }
    page = await settleAfterPrimaryClick(context, page);
  }

  return {
    page,
    route: "company_specific"
  };
}

async function resolveApplicationEntry(context: BrowserContext, startPage: Page, osInput?: WindowsOsInputDriver): Promise<ApplicationEntryResult> {
  if (!isLinkedInUrl(startPage.url())) {
    return resolveExternalCompanyEntry(context, startPage, osInput);
  }
  return resolveLinkedInEntry(context, startPage, osInput);
}

async function resumeApplicationEntryAfterAuth(
  context: BrowserContext,
  page: Page,
  route: ApplyEntryRoute,
  osInput?: WindowsOsInputDriver
): Promise<ApplicationEntryResult> {
  if (await looksLikeLoginSurface(page)) {
    const dismissedAuthenticatedOverlay = await dismissAuthenticatedLoginOverlay(page);
    if (!dismissedAuthenticatedOverlay) {
      return {
        page,
        route
      };
    }
  }
  if (route === "workday" && isWorkdayUrl(page.url())) {
    return resolveWorkdayEntry(context, page, osInput);
  }
  if ((route === "company_specific" || route === "generic_apply" || route === "direct_form") && !isLinkedInUrl(page.url())) {
    return resolveExternalCompanyEntry(context, page, osInput);
  }
  return {
    page,
    route
  };
}

interface ProgressiveAutofillResult {
  missingKeys: string[];
  roleAnswersUsed: number;
  resumeUploaded: boolean;
  reachedFinalLinkedInStep: boolean;
  reachedFinalSubmitStep: boolean;
  unresolvedRequiredPrompts: string[];
}

async function applicationStepSignature(page: Page): Promise<string> {
  return page.evaluate(() => {
    const root = (globalThis as any).document as any;
    const heading = root?.querySelector?.("h1, h2, h3, [aria-live='polite']")?.textContent ?? "";
    const buttons = Array.from(root?.querySelectorAll?.("button") ?? [])
      .slice(0, 8)
      .map((button: any) => (button?.textContent ?? "").replace(/\s+/g, " ").trim())
      .filter((text: string) => text.length > 0)
      .join("|");
    return `${String(heading).replace(/\s+/g, " ").trim()}::${buttons}`;
  }).catch(() => "");
}

function shouldProgressApplicationSteps(route: ApplyEntryRoute): boolean {
  return route === "linkedin_easy_apply"
    || route === "linkedin_apply"
    || route === "workday"
    || route === "company_specific"
    || route === "generic_apply";
}

function isLinkedInRoute(route: ApplyEntryRoute): boolean {
  return route === "linkedin_easy_apply" || route === "linkedin_apply";
}

function isOptionalRouteKey(route: ApplyEntryRoute, key: string): boolean {
  return route === "linkedin_easy_apply" && key === "linkedin";
}

function summarizePromptForMessage(prompt: string): string {
  const collapsed = prompt.replace(/\s+/g, " ").trim();
  if (collapsed.length <= 72) {
    return collapsed;
  }
  return `${collapsed.slice(0, 69).trimEnd()}...`;
}

function buildAutofillStatusMessage(
  autofill: ProgressiveAutofillResult,
  finalSubmitDisabledLabel: string,
  blockerLabel?: string | null
): string {
  if (autofill.unresolvedRequiredPrompts.length > 0) {
    const summarized = autofill.unresolvedRequiredPrompts
      .slice(0, 2)
      .map((prompt) => summarizePromptForMessage(prompt))
      .join("; ");
    const remainder = autofill.unresolvedRequiredPrompts.length > 2
      ? ` (+${autofill.unresolvedRequiredPrompts.length - 2} more)`
      : "";
    return `Stopped before final submit; unresolved required prompts remain: ${summarized}${remainder}.`;
  }
  if (blockerLabel != null && blockerLabel.length > 0) {
    return `Stopped before final submit at ${blockerLabel}.`;
  }
  if (autofill.reachedFinalLinkedInStep) {
    return `Reached final LinkedIn Easy Apply step; ${finalSubmitDisabledLabel}`;
  }
  if (autofill.reachedFinalSubmitStep) {
    return `Reached the final submit step; ${finalSubmitDisabledLabel}`;
  }
  return finalSubmitDisabledLabel;
}

function maxAutofillPassesForRoute(route: ApplyEntryRoute): number {
  if (route === "linkedin_easy_apply") {
    return 8;
  }
  if (route === "workday") {
    return 5;
  }
  if (route === "company_specific") {
    return 4;
  }
  if (route === "linkedin_apply" || route === "generic_apply") {
    return 3;
  }
  return 2;
}

function progressionSelectorsForRoute(route: ApplyEntryRoute): string[] {
  if (route === "linkedin_easy_apply") {
    return [
      "button:has-text('Next')",
      "button:has-text('Review')",
      "button:has-text('Continue to next step')",
      "button:has-text('Continue')",
      "button:has-text('Save and continue')"
    ];
  }
  if (route === "workday") {
    return [
      "a[data-automation-id='applyManually']",
      "button[data-automation-id='applyManually']",
      "a:has-text('Apply Manually')",
      "button:has-text('Apply Manually')",
      "button[data-automation-id='pageFooterNextButton']",
      "button[data-automation-id*='next' i]",
      "button[data-automation-id*='continue' i]",
      "button:has-text('Save and Continue')",
      "button:has-text('Continue')",
      "button:has-text('Next')",
      "button:has-text('Review')"
    ];
  }
  return [
    "button:has-text('Apply')",
    "a:has-text('Apply')",
    "input[value='Apply']",
    "button:has-text('Apply now')",
    "a:has-text('Apply now')",
    "button:has-text('Apply for this job')",
    "a:has-text('Apply for this job')",
    "button:has-text('Start application')",
    "a:has-text('Start application')",
    "button:has-text('Sign In')",
    "a:has-text('Sign In')",
    "input[value='Sign In']",
    "button:has-text('Continue')",
    "a:has-text('Continue')",
    "input[value='Continue']",
    "input[type='submit']",
    "button:has-text('Continue to application')",
    "a:has-text('Continue to application')",
    "button:has-text('Next')",
    "button:has-text('Review')",
    "button:has-text('Save and continue')"
  ];
}

function progressionOcrTargetsForRoute(route: ApplyEntryRoute): string[] {
  if (route === "linkedin_easy_apply") {
    return ["next", "review", "continue"];
  }
  if (route === "workday") {
    return ["apply manually", "save and continue", "continue", "next", "review"];
  }
  return ["apply", "apply now", "sign in", "continue", "next", "review", "start"];
}

async function progressApplicationStep(page: Page, route: ApplyEntryRoute, osInput?: WindowsOsInputDriver): Promise<boolean> {
  const selectors = progressionSelectorsForRoute(route);
  if (route === "workday") {
    const directWorkdayProgress = await clickSelectorsPlaywrightFirst(page, [
      "button[data-automation-id='pageFooterNextButton']",
      "button[data-automation-id*='continue' i]",
      "button[data-automation-id*='next' i]",
      "button:has-text('Save and Continue')",
      "button:has-text('Continue')",
      "button:has-text('Next')",
      "button:has-text('Review')"
    ], 10000, false);
    if (directWorkdayProgress) {
      return true;
    }
  }
  for (const ref of collectFillContexts(page)) {
    const clicked = await clickFirstCandidateInContext(
      ref.context,
      selectors,
      ref.allowOsInput ? osInput : undefined,
      10000
    );
    if (clicked) {
      return true;
    }
  }
  return clickAdaptiveCandidate(
    page,
    selectors,
    progressionOcrTargetsForRoute(route),
    osInput,
    10000,
    true,
    "light",
    osInput != null,
    true
  );
}

async function hasEnabledProgressionCandidate(page: Page, route: ApplyEntryRoute): Promise<boolean> {
  const selectors = progressionSelectorsForRoute(route);
  for (const ref of collectFillContexts(page)) {
    if (await hasEnabledCandidateInContext(ref.context, selectors)) {
      return true;
    }
  }
  return false;
}

async function hasVisibleFinalSubmitStep(page: Page, route: ApplyEntryRoute): Promise<boolean> {
  const selectors = route === "linkedin_easy_apply"
    ? [
        "button:has-text('Submit application')",
        "button[aria-label*='Submit application' i]",
        "button:has-text('Submit')"
      ]
    : [
        "button#btn-submit",
        "button[data-qa='btn-submit']",
        "button[type='submit']",
        "input[type='submit']",
        "button:has-text('Submit application')",
        "button[aria-label*='Submit application' i]",
        "button:has-text('Submit')",
        "button:has-text('Send application')",
        "button:has-text('Complete application')"
      ];
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if (await locator.count().catch(() => 0) === 0) {
      continue;
    }
    if (!await locator.isVisible().catch(() => false)) {
      continue;
    }
    if (await locator.isDisabled().catch(() => false)) {
      continue;
    }
    return true;
  }
  if (route !== "linkedin_easy_apply") {
    const leverSubmitVisible = await page.evaluate(() => {
      const root = globalThis as any;
      const submit = root.document?.querySelector?.("#btn-submit, button[data-qa='btn-submit']") as any;
      if (!submit || typeof submit.getBoundingClientRect !== "function") {
        return false;
      }
      const style = root.getComputedStyle?.(submit);
      if (!style) {
        return false;
      }
      const rect = submit.getBoundingClientRect();
      return style.visibility !== "hidden"
        && style.display !== "none"
        && rect.width > 0
        && rect.height > 0
        && !submit.hasAttribute("disabled")
        && submit.getAttribute("aria-disabled") !== "true";
    }).catch(() => false);
    if (leverSubmitVisible) {
      return true;
    }
  }
  return false;
}

async function runProgressiveAutofill(
  page: Page,
  draft: ApplicationDraft,
  resumePath: string,
  additionalAnswers: Record<string, string>,
  route: ApplyEntryRoute,
  osInput?: WindowsOsInputDriver,
  debugSession?: AutoApplyDebugSession | null
): Promise<ProgressiveAutofillResult> {
  const expectedKeys = mergedAnswerKeys(draft, additionalAnswers)
    .filter((key) => !isOptionalRouteKey(route, key));
  const filledKeys = new Set<string>();
  const candidateKeys = new Set<string>();
  let roleAnswersUsedTotal = 0;
  let resumeUploaded = false;
  let reachedFinalLinkedInStep = false;
  let reachedFinalSubmitStep = false;
  let unresolvedRequiredPrompts: string[] = [];
  const maxPasses = maxAutofillPassesForRoute(route);
  let previousSignature = "";

  for (let pass = 0; pass < maxPasses; pass += 1) {
    if (isLinkedInRoute(route) && (isLinkedInFeedUrl(page.url()) || isLinkedInCollectionsUrl(page.url()))) {
      throw new Error(`LinkedIn apply flow drifted away from the application form: ${page.url()}`);
    }

    const autofill = await autofillApplication(page, draft, resumePath, additionalAnswers, osInput);
    for (const key of autofill.filledKeys) {
      filledKeys.add(key);
    }
    for (const key of autofill.candidateKeys) {
      candidateKeys.add(key);
    }
    roleAnswersUsedTotal += autofill.roleAnswersUsed;
    resumeUploaded = resumeUploaded || autofill.resumeUploaded;
    await captureAutoApplyDebugSnapshot(debugSession ?? null, page, `pass-${pass + 1}-after-fill`, {
      route,
      pass: pass + 1,
      maxPasses,
      expectedKeys,
      filledKeys: autofill.filledKeys,
      candidateKeys: autofill.candidateKeys,
      missingKeysCurrentPass: autofill.missingKeys,
      roleAnswersUsedCurrentPass: autofill.roleAnswersUsed,
      resumeUploadedCurrentPass: autofill.resumeUploaded
    });

    const visibleStepFill = await fillVisibleStepFields(page, draft, additionalAnswers, osInput);
    await captureAutoApplyDebugSnapshot(debugSession ?? null, page, `pass-${pass + 1}-after-visible-field-fill`, {
      route,
      pass: pass + 1,
      filledPromptsCurrentPass: visibleStepFill.filledPrompts,
      unresolvedRequiredPromptsCurrentPass: visibleStepFill.unresolvedRequiredPrompts
    });
    unresolvedRequiredPrompts = visibleStepFill.unresolvedRequiredPrompts;
    if (visibleStepFill.filledPrompts.length > 0) {
      const finalStepVisibleAfterFill = await hasVisibleFinalSubmitStep(page, route);
      if (finalStepVisibleAfterFill) {
        reachedFinalSubmitStep = true;
        if (route === "linkedin_easy_apply") {
          reachedFinalLinkedInStep = true;
        }
        await captureAutoApplyDebugSnapshot(debugSession ?? null, page, `pass-${pass + 1}-final-submit-step`, {
          route,
          pass: pass + 1,
          reachedFinalLinkedInStep,
          reachedFinalSubmitStep: true
        });
        break;
      }
      const canProgressAfterFill = await hasEnabledProgressionCandidate(page, route);
      if (!canProgressAfterFill) {
        continue;
      }
    }
    if (visibleStepFill.unresolvedRequiredPrompts.length > 0) {
      break;
    }

    if (!shouldProgressApplicationSteps(route)) {
      break;
    }

    const finalStepVisible = await hasVisibleFinalSubmitStep(page, route);
    if (finalStepVisible) {
      reachedFinalSubmitStep = true;
      if (route === "linkedin_easy_apply") {
        reachedFinalLinkedInStep = true;
      }
      await captureAutoApplyDebugSnapshot(debugSession ?? null, page, `pass-${pass + 1}-final-submit-step`, {
        route,
        pass: pass + 1,
        reachedFinalLinkedInStep,
        reachedFinalSubmitStep: true
      });
      break;
    }

    const beforeSignature = await applicationStepSignature(page);
    const progressed = await progressApplicationStep(page, route, osInput);
    await captureAutoApplyDebugSnapshot(debugSession ?? null, page, `pass-${pass + 1}-after-progress-attempt`, {
      route,
      pass: pass + 1,
      progressed,
      beforeSignature
    });
    if (!progressed) {
      break;
    }
    await waitForLightSettle(page);
    const afterSignature = await applicationStepSignature(page);
    if (isLinkedInRoute(route) && (isLinkedInFeedUrl(page.url()) || isLinkedInCollectionsUrl(page.url()))) {
      throw new Error(`LinkedIn apply flow drifted away from the application form: ${page.url()}`);
    }
    await captureAutoApplyDebugSnapshot(debugSession ?? null, page, `pass-${pass + 1}-after-progress-settle`, {
      route,
      pass: pass + 1,
      beforeSignature,
      afterSignature
    });
    if (afterSignature.length > 0 && afterSignature === beforeSignature && afterSignature === previousSignature) {
      break;
    }
    previousSignature = afterSignature;
  }

  if (!reachedFinalSubmitStep && await hasVisibleFinalSubmitStep(page, route)) {
    reachedFinalSubmitStep = true;
    if (route === "linkedin_easy_apply") {
      reachedFinalLinkedInStep = true;
    }
    await captureAutoApplyDebugSnapshot(debugSession ?? null, page, "post-loop-final-submit-step", {
      route,
      reachedFinalLinkedInStep,
      reachedFinalSubmitStep: true
    });
  }

  const missingBaseline = unique(Array.from(candidateKeys))
    .filter((key) => !isOptionalRouteKey(route, key));
  const missingKeys = missingBaseline.filter((key) => !filledKeys.has(key));
  return {
    missingKeys,
    roleAnswersUsed: roleAnswersUsedTotal,
    resumeUploaded,
    reachedFinalLinkedInStep,
    reachedFinalSubmitStep,
    unresolvedRequiredPrompts
  };
}

async function detectAutofillBlocker(page: Page): Promise<string | null> {
  const hasHCaptchaFrame = page.frames().some((frame) => /hcaptcha\.com/i.test(frame.url()));
  if (hasHCaptchaFrame) {
    return "an hCaptcha verification gate";
  }
  const hasRecaptchaFrame = page.frames().some((frame) => /recaptcha/i.test(frame.url()));
  if (hasRecaptchaFrame) {
    return "a reCAPTCHA verification gate";
  }
  if (await looksLikeLoginSurface(page)) {
    return "a login gate";
  }
  if (await looksLikeSignupSurface(page)) {
    return "an account creation gate";
  }
  return null;
}

function looksLikeLoginSurface(page: Page): Promise<boolean> {
  return (async () => {
    const passwordCount = await page.locator("input[type='password'], input[name*='password' i], input[id*='password' i]").count().catch(() => 0);
    if (passwordCount === 0) {
      return false;
    }
    const emailCount = await page.locator("input[type='email'], input[name*='email' i], input[id*='email' i], input[autocomplete='email'], input[data-automation-id='email']").count().catch(() => 0)
      + await page.getByLabel(/email/i).count().catch(() => 0);
    const loginButtonCount = await page.locator(
      "button:has-text('Sign in'), button:has-text('Sign In'), button:has-text('Log in'), button:has-text('Login'), button[data-automation-id='signInSubmitButton'], input[type='submit']"
    ).count().catch(() => 0);
    const titleText = await page.locator("h1, h2, h3, [data-automation-id='signInContent']").innerText().catch(() => "");
    return emailCount > 0 || loginButtonCount > 0 || /sign in|log in/i.test(titleText);
  })().catch(() => false);
}

function looksLikeSignupSurface(page: Page): Promise<boolean> {
  return (async () => {
    const emailCount = await page.locator(
      "input[type='email'], input[name*='email' i], input[id*='email' i]"
    ).count().catch(() => 0) + await page.getByLabel(/email/i).count().catch(() => 0);
    const passwordCount = await page.locator("input[type='password'], input[name*='password' i], input[id*='password' i]").count().catch(() => 0);
    const verifyPasswordCount = await page.locator(
      "input[name*='verify' i], input[id*='verify' i]"
    ).count().catch(() => 0) + await page.getByLabel(/verify.*password|confirm.*password/i).count().catch(() => 0);
    const nameCount = await page.locator(
      "input[name*='first' i], input[id*='first' i], input[name*='last' i], input[id*='last' i], input[autocomplete='given-name'], input[autocomplete='family-name']"
    ).count().catch(() => 0);
    const createAccountCount = await page.locator(
      "button:has-text('Create account'), a:has-text('Create account'), button:has-text('Sign up'), a:has-text('Sign up'), button:has-text('Register')"
    ).count().catch(() => 0);
    return emailCount > 0
      && passwordCount > 0
      && (nameCount > 0 || verifyPasswordCount > 0 || createAccountCount > 0);
  })().catch(() => false);
}

async function submitCredentialSurface(
  page: Page,
  email: string,
  password: string,
  osInput?: WindowsOsInputDriver
): Promise<boolean> {
  const emailLocator = await firstExistingLocator([
    page.locator("input[type='email'], input[name*='email' i], input[id*='email' i], input[autocomplete='email'], input[data-automation-id='email']").first(),
    page.getByLabel(/email/i).first()
  ]);
  const passwordLocator = await firstExistingLocator([
    page.locator("input[type='password'], input[name*='password' i], input[id*='password' i], input[autocomplete='current-password']").first(),
    page.getByLabel(/password/i).first()
  ]);
  if (emailLocator == null || passwordLocator == null) {
    return false;
  }

  const emailFilled = await tryFillLocator(emailLocator, email, osInput);
  const passwordFilled = await tryFillLocator(passwordLocator, password, osInput);
  if (!emailFilled) {
    await emailLocator.fill(email).catch(() => undefined);
  }
  if (!passwordFilled) {
    await passwordLocator.fill(password).catch(() => undefined);
  }
  const emailValue = await emailLocator.inputValue().catch(() => "");
  const passwordValue = await passwordLocator.inputValue().catch(() => "");
  if (emailValue.trim().length === 0 || passwordValue.length === 0) {
    return false;
  }
  const submitSelectors = [
    "div[role='button'][aria-label='Sign In']",
    "[data-automation-id='click_filter'][aria-label='Sign In']",
    "button[data-automation-id='signInSubmitButton']",
    "button[type='submit']",
    "input[type='submit']",
    "button:has-text('Sign in')",
    "button:has-text('Sign In')",
    "button:has-text('Log in')",
    "button:has-text('Continue')",
    "button:has-text('Next')",
    "button:has-text('Submit')"
  ];
  let submitted = await clickSelectorsPlaywrightFirst(page, submitSelectors, 10000, true);
  if (!submitted) {
    submitted = await passwordLocator.press("Enter").then(() => true).catch(() => false);
    if (submitted) {
      await waitForPageSettle(page);
    }
  }
  if (!submitted) {
    submitted = await clickFirstCandidate(page, submitSelectors, osInput, 10000, true);
  }
  await page.waitForTimeout(1000).catch(() => undefined);
  return submitted;
}

async function looksAuthenticatedCareerSiteSession(page: Page): Promise<boolean> {
  const accountButton = page.locator("[data-automation-id='accountSettingsButton']").first();
  const accountButtonText = await accountButton.innerText().catch(() => "");
  if (/@/.test(accountButtonText)) {
    return true;
  }
  const candidateHomeCount = await page.locator(
    "[data-automation-id='navigationItem-Candidate Home'], a:has-text('Candidate Home'), button:has-text('Candidate Home')"
  ).count().catch(() => 0);
  if (candidateHomeCount > 0) {
    return true;
  }
  const accountMenuCount = await page.locator("[data-automation-id='utilityButtonAccountTasksMenu']").count().catch(() => 0);
  return accountMenuCount > 0;
}

async function dismissAuthenticatedLoginOverlay(page: Page): Promise<boolean> {
  if (!await looksLikeLoginSurface(page)) {
    return false;
  }
  if (!await looksAuthenticatedCareerSiteSession(page)) {
    return false;
  }
  const closed = await clickSelectorsPlaywrightFirst(page, [
    "[data-automation-id='popUpDialog'] button[aria-label='Close']",
    "button[aria-label='Close']"
  ], 5000, true);
  if (!closed) {
    return false;
  }
  await waitForPageSettle(page);
  return !await looksLikeLoginSurface(page);
}

async function openLoginSurfaceIfAvailable(page: Page, osInput?: WindowsOsInputDriver): Promise<boolean> {
  if (await looksLikeLoginSurface(page)) {
    return true;
  }
  const clicked = await clickFirstCandidate(page, [
    "button[data-automation-id='signInLink']",
    "button[data-automation-id='utilityButtonSignIn']",
    "a[data-automation-id='utilityButtonSignIn']",
    "button:has-text('Sign In')",
    "a:has-text('Sign In')"
  ], osInput, 8000, true);
  if (!clicked) {
    return false;
  }
  await waitForPageSettle(page);
  return await looksLikeLoginSurface(page);
}

async function attemptCreateAccount(
  page: Page,
  profile: AutoApplyLoginProfile,
  osInput?: WindowsOsInputDriver
): Promise<boolean> {
  const movedToSignup = await clickFirstCandidate(page, [
    "button:has-text('Create account')",
    "a:has-text('Create account')",
    "button:has-text('Sign up')",
    "a:has-text('Sign up')",
    "button:has-text('Register')",
    "a:has-text('Register')"
  ], osInput, 8000);
  if (!movedToSignup && !await looksLikeSignupSurface(page)) {
    return false;
  }
  if (!await looksLikeSignupSurface(page)) {
    return false;
  }

  const firstNameLocator = await firstExistingLocator([
    page.locator("input[name*='first' i], input[id*='first' i], input[autocomplete='given-name']").first(),
    page.getByLabel(/first name|given name/i).first()
  ]);
  if (firstNameLocator != null) {
    await tryFillLocator(firstNameLocator, profile.firstName, osInput);
  }

  const lastNameLocator = await firstExistingLocator([
    page.locator("input[name*='last' i], input[id*='last' i], input[autocomplete='family-name']").first(),
    page.getByLabel(/last name|family name/i).first()
  ]);
  if (lastNameLocator != null) {
    await tryFillLocator(lastNameLocator, profile.lastName, osInput);
  }

  const signupEmailLocator = await firstExistingLocator([
    page.locator("input[type='email'], input[name*='email' i], input[id*='email' i], input[autocomplete='email']").first(),
    page.getByLabel(/email/i).first()
  ]);
  if (signupEmailLocator != null) {
    await tryFillLocator(signupEmailLocator, profile.email, osInput);
  }

  const signupPasswordLocator = await firstExistingLocator([
    page.locator("input[type='password'], input[name*='password' i], input[id*='password' i], input[autocomplete='new-password']").first(),
    page.getByLabel(/^password/i).first()
  ]);
  if (signupPasswordLocator != null) {
    await tryFillLocator(signupPasswordLocator, profile.password, osInput);
  }

  const verifyPasswordLocator = await firstExistingLocator([
    page.locator("input[name*='verify' i], input[id*='verify' i]").first(),
    page.getByLabel(/verify.*password|confirm.*password/i).first()
  ]);
  if (verifyPasswordLocator != null) {
    await tryFillLocator(verifyPasswordLocator, profile.password, osInput);
  }

  const termsLocator = await firstExistingLocator([
    page.getByLabel(/terms|conditions|privacy|consent/i).first(),
    page.locator("input[type='checkbox']").first()
  ]);
  if (termsLocator != null) {
    await tryFillLocator(termsLocator, "yes", osInput);
  }

  const initialUrl = page.url();
  const submitted = await clickFirstCandidate(page, [
    "div[role='button'][aria-label='Create Account']",
    "[data-automation-id='click_filter'][aria-label='Create Account']",
    "button[data-automation-id='createAccountSubmitButton']",
    "button[type='submit']",
    "input[type='submit']",
    "button:has-text('Create account')",
    "button:has-text('Create Account')",
    "button:has-text('Sign up')",
    "button:has-text('Register')",
    "button:has-text('Continue')"
  ], osInput, 10000, true);
  await page.waitForTimeout(1000).catch(() => undefined);
  if (!submitted) {
    return false;
  }
  const changedUrl = page.url() !== initialUrl;
  const stillSignupSurface = await looksLikeSignupSurface(page);
  return changedUrl || !stillSignupSurface;
}

async function pollVerificationEmailAction(
  settings: AutoApplyOtpSettings,
  preferredKind: EmailVerificationAction["kind"]
): Promise<EmailVerificationAction | null> {
  const start = Date.now();
  while (Date.now() - start < settings.timeoutMs) {
    const client = new ImapFlow({
      host: settings.host,
      port: settings.port,
      secure: settings.secure,
      auth: {
        user: settings.user,
        pass: settings.password
      },
      logger: false
    });

    try {
      await client.connect();
      const lock = await client.getMailboxLock(settings.mailbox);
      try {
        const mailbox = await client.mailboxOpen(settings.mailbox, { readOnly: true });
        const fromSeq = Math.max(1, mailbox.exists - 25);
        let selectedAction: EmailVerificationAction | null = null;
        let selectedTs = 0;
        for await (const message of client.fetch(`${fromSeq}:*`, {
          envelope: true,
          source: true,
          internalDate: true
        })) {
          const rawDate = message.internalDate;
          const messageTs = rawDate == null ? 0 : Number(new Date(rawDate).getTime());
          if (messageTs > 0 && (Date.now() - messageTs) > (15 * 60 * 1000)) {
            continue;
          }
          const subject = message.envelope?.subject ?? "";
          const sourceText = message.source?.toString("utf8") ?? "";
          const messageText = `${subject}\n${sourceText}`;
          const code = extractOtpCodeFromText(messageText);
          const verificationUrl = extractVerificationUrlFromText(messageText);
          const action = preferredKind === "otp"
            ? (code != null
                ? { kind: "otp", value: code } satisfies EmailVerificationAction
                : verificationUrl != null
                  ? { kind: "link", value: verificationUrl } satisfies EmailVerificationAction
                  : null)
            : (verificationUrl != null
                ? { kind: "link", value: verificationUrl } satisfies EmailVerificationAction
                : code != null
                  ? { kind: "otp", value: code } satisfies EmailVerificationAction
                  : null);
          if (action == null) {
            continue;
          }
          if (messageTs >= selectedTs) {
            selectedAction = action;
            selectedTs = messageTs;
          }
        }
        if (selectedAction != null) {
          return selectedAction;
        }
      } finally {
        lock.release();
      }
    } catch {
      // Best effort: retry until timeout
    } finally {
      await client.logout().catch(() => {
        client.close();
      });
    }
    await sleep(settings.pollMs);
  }
  return null;
}

async function looksLikeEmailVerificationGate(page: Page): Promise<boolean> {
  const bodyText = await page.locator("body").innerText().catch(() => "");
  return /email has been sent.*verify|please verify your account|verify your (candidate )?account|verify your email|check your email/i.test(bodyText);
}

async function applyEmailVerificationIfPrompted(
  page: Page,
  otpSettings: AutoApplyOtpSettings | null
): Promise<boolean> {
  if (!await looksLikeEmailVerificationGate(page)) {
    return false;
  }
  if (otpSettings == null) {
    throw new Error(
      "Email verification is required, but IMAP polling is not configured. Set IMAP settings so Career Ops can inspect verification emails."
    );
  }
  const action = await pollVerificationEmailAction(otpSettings, "link");
  if (action == null) {
    throw new Error(`Unable to find a verification email in mailbox ${otpSettings.mailbox} within ${otpSettings.timeoutMs}ms.`);
  }
  if (action.kind !== "link") {
    return false;
  }
  await page.goto(action.value, { waitUntil: "domcontentloaded", timeout: 60000 });
  await waitForPageSettle(page);
  return true;
}

async function applyVerificationCodeIfPrompted(
  page: Page,
  otpSettings: AutoApplyOtpSettings | null,
  osInput?: WindowsOsInputDriver
): Promise<boolean> {
  const otpLocator = await firstExistingLocator([
    page.getByLabel(/verification code|security code|one[- ]time code|otp|passcode/i),
    page.locator("input[autocomplete='one-time-code']").first(),
    page.locator(
      [
        "input[name*='otp' i]",
        "input[id*='otp' i]",
        "input[name*='verification' i]",
        "input[id*='verification' i]",
        "input[name*='passcode' i]",
        "input[id*='passcode' i]",
        "input[aria-label*='verification code' i]",
        "input[placeholder*='verification code' i]",
        "input[aria-label*='security code' i]",
        "input[placeholder*='security code' i]"
      ].join(", ")
    ).first()
  ]);
  if (otpLocator == null) {
    return false;
  }
  if (!await otpLocator.isVisible().catch(() => false)) {
    return false;
  }
  const otpPrompt = await otpLocator.evaluate((element) => [
    String((element as any).getAttribute?.("name") ?? ""),
    String((element as any).getAttribute?.("id") ?? ""),
    String((element as any).getAttribute?.("aria-label") ?? ""),
    String((element as any).getAttribute?.("placeholder") ?? ""),
    Array.from(((element as any).labels ?? []) as any[])
      .map((label: any) => String(label?.textContent ?? "").replace(/\s+/g, " ").trim())
      .join(" ")
  ].join(" ").toLowerCase()).catch(() => "");
  if (!/(verification|security|passcode|one[- ]time|otp|auth)/i.test(otpPrompt)) {
    return false;
  }
  if (otpSettings == null) {
    throw new Error(
      "A verification code is required, but OTP polling is not configured. Set IMAP settings to auto-fill email codes."
    );
  }
  const action = await pollVerificationEmailAction(otpSettings, "otp");
  if (action == null) {
    throw new Error(`Unable to find verification code in mailbox ${otpSettings.mailbox} within ${otpSettings.timeoutMs}ms.`);
  }
  if (action.kind !== "otp") {
    throw new Error("A verification input is visible, but the mailbox only contained an activation link instead of a numeric code.");
  }
  await tryFillLocator(otpLocator, action.value, osInput);
  await clickFirstCandidate(page, [
    "button[type='submit']",
    "input[type='submit']",
    "button:has-text('Verify')",
    "button:has-text('Continue')",
    "button:has-text('Next')",
    "button:has-text('Submit')"
  ], osInput, 10000, true);
  await waitForPageSettle(page);
  return true;
}

async function attemptLoginSignupAndOtp(
  page: Page,
  loginProfile: AutoApplyLoginProfile | null,
  otpSettings: AutoApplyOtpSettings | null,
  osInput?: WindowsOsInputDriver
): Promise<{
  loginAttempted: boolean;
  accountCreated: boolean;
  otpCodeUsed: boolean;
}> {
  let loginAttempted = false;
  let accountCreated = false;
  let otpCodeUsed = false;

  if (loginProfile != null) {
    const alreadyAuthenticated = await looksAuthenticatedCareerSiteSession(page);
    if (!alreadyAuthenticated) {
      await openLoginSurfaceIfAvailable(page, osInput);
    }
  }

  if (await looksLikeLoginSurface(page)) {
    await dismissAuthenticatedLoginOverlay(page);
  }

  if (loginProfile != null && await looksLikeLoginSurface(page)) {
    loginAttempted = await submitCredentialSurface(page, loginProfile.email, loginProfile.password, osInput);
    await waitForPageSettle(page);
    if (await looksLikeLoginSurface(page)) {
      await dismissAuthenticatedLoginOverlay(page);
    }

    if (loginProfile.allowCreateAccount && await looksLikeLoginSurface(page)) {
      accountCreated = await attemptCreateAccount(page, loginProfile, osInput);
      await waitForPageSettle(page);
    }
  }

  otpCodeUsed = await applyVerificationCodeIfPrompted(page, otpSettings, osInput);
  const verificationLinkUsed = !otpCodeUsed
    ? await applyEmailVerificationIfPrompted(page, otpSettings)
    : false;
  if (verificationLinkUsed && loginProfile != null && await looksLikeLoginSurface(page)) {
    loginAttempted = await submitCredentialSurface(page, loginProfile.email, loginProfile.password, osInput) || loginAttempted;
    await waitForPageSettle(page);
  }
  return {
    loginAttempted,
    accountCreated,
    otpCodeUsed
  };
}

async function assertResolvedAuthSurface(page: Page): Promise<void> {
  if (await dismissAuthenticatedLoginOverlay(page)) {
    return;
  }
  const blockedOnLogin = await looksLikeLoginSurface(page);
  const blockedOnSignup = !blockedOnLogin && await looksLikeSignupSurface(page);
  if (!blockedOnLogin && !blockedOnSignup) {
    return;
  }
  const blocker = blockedOnLogin ? "sign-in" : "sign-up";
  const details = await describeBlockingSurface(page);
  throw new Error(
    `Autoapply is still blocked on a ${blocker} surface after the auth handoff. ${details}`.trim()
  );
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
  mode?: string;
  osDryRun?: boolean;
  loginEmail?: string;
  loginPassword?: string;
  loginFirstName?: string;
  loginLastName?: string;
  allowCreateAccount?: boolean;
  otpHost?: string;
  otpPort?: string;
  otpSecure?: string;
  otpUser?: string;
  otpPassword?: string;
  otpMailbox?: string;
  otpTimeoutMs?: string;
  otpPollMs?: string;
}): AutoApplyOptions {
  const mode = parseAutoApplyMode(raw.mode ?? process.env[AUTOAPPLY_ENV_MODE]);
  ensureOsModeSupport(mode);
  const resumePath = resolveRequiredResumePath(raw.resume);
  const additionalAnswers = loadAdditionalAnswersFromPath(raw.info);
  const submit = raw.submit === true || parseBooleanFlag(process.env[AUTOAPPLY_ENV_SUBMIT]);
  const headless = raw.headless === true;
  if (mode === "pyautogui" && headless) {
    throw new Error("PyAutoGUI mode requires a visible browser. Remove --headless or switch to --mode playwright.");
  }
  const waitMs = raw.waitMs == null ? AUTOAPPLY_DEFAULT_WAIT_MS : Number(raw.waitMs);
  if (!Number.isFinite(waitMs) || waitMs < 0) {
    throw new Error(`Invalid --wait-ms value: ${raw.waitMs}`);
  }
  const limit = raw.limit == null ? 0 : Number(raw.limit);
  if (!Number.isFinite(limit) || limit < 0) {
    throw new Error(`Invalid --limit value: ${raw.limit}`);
  }
  const identity = resolveAutoApplyIdentity();
  const loginProfile = resolveLoginProfile(identity, {
    loginEmail: raw.loginEmail,
    loginPassword: raw.loginPassword,
    loginFirstName: raw.loginFirstName,
    loginLastName: raw.loginLastName,
    allowCreateAccount: raw.allowCreateAccount
  });
  const otpSettings = resolveOtpSettings({
    otpHost: raw.otpHost,
    otpPort: raw.otpPort,
    otpSecure: raw.otpSecure,
    otpUser: raw.otpUser,
    otpPassword: raw.otpPassword,
    otpMailbox: raw.otpMailbox,
    otpTimeoutMs: raw.otpTimeoutMs,
    otpPollMs: raw.otpPollMs
  });
  return {
    resumePath,
    additionalAnswers,
    submit,
    headless,
    waitMs,
    limit,
    mode,
    osDryRun: raw.osDryRun === true || parseBooleanOption(process.env[AUTOAPPLY_ENV_OS_DRY_RUN], false),
    loginProfile,
    otpSettings
  };
}

function parseAutoApplySingleOptions(raw: {
  jobId?: string;
  url?: string;
  resume?: string;
  info?: string;
  headless?: boolean;
  waitMs?: string;
  mode?: string;
  osDryRun?: boolean;
  loginEmail?: string;
  loginPassword?: string;
  loginFirstName?: string;
  loginLastName?: string;
  allowCreateAccount?: boolean;
  otpHost?: string;
  otpPort?: string;
  otpSecure?: string;
  otpUser?: string;
  otpPassword?: string;
  otpMailbox?: string;
  otpTimeoutMs?: string;
  otpPollMs?: string;
  debugArtifacts?: boolean;
  debugDir?: string;
}): AutoApplySingleRunOptions {
  if ((raw as { submit?: boolean }).submit === true) {
    throw new Error("autoapply-test is safety-locked and never submits the final application.");
  }
  const parsed = parseAutoApplyOptions({
    resume: raw.resume,
    info: raw.info,
    submit: false,
    headless: raw.headless,
    waitMs: raw.waitMs,
    mode: raw.mode,
    osDryRun: raw.osDryRun,
    loginEmail: raw.loginEmail,
    loginPassword: raw.loginPassword,
    loginFirstName: raw.loginFirstName,
    loginLastName: raw.loginLastName,
    allowCreateAccount: raw.allowCreateAccount,
    otpHost: raw.otpHost,
    otpPort: raw.otpPort,
    otpSecure: raw.otpSecure,
    otpUser: raw.otpUser,
    otpPassword: raw.otpPassword,
    otpMailbox: raw.otpMailbox,
    otpTimeoutMs: raw.otpTimeoutMs,
    otpPollMs: raw.otpPollMs
  });

  const jobId = raw.jobId == null ? undefined : Number(raw.jobId);
  if (raw.jobId != null && (!Number.isFinite(jobId) || jobId == null || jobId <= 0)) {
    throw new Error(`Invalid --job-id value: ${raw.jobId}`);
  }
  const debugDir = raw.debugDir?.trim().length
    ? path.resolve(rootDir, raw.debugDir.trim())
    : undefined;

  return {
    ...parsed,
    limit: 1,
    jobId,
    targetUrl: raw.url?.trim().length ? raw.url.trim() : undefined,
    debugArtifacts: raw.debugArtifacts !== false,
    debugDir
  };
}

async function runShortlistAutoApply(options: AutoApplyOptions): Promise<AutoApplySummary> {
  const pipeline = new CareerOpsPipeline(rootDir, dbPath);
  let context: BrowserContext | null = null;
  try {
    const candidates = pipeline.repo.listJobs()
      .filter((record) => SHORTLIST_AUTOAPPLY_STATUSES.includes(record.job.status))
      .filter((record) => resolveLinkedInAutoApplyTargetUrl(record.job) != null)
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
      const entryTargetUrl = resolveLinkedInAutoApplyTargetUrl(candidate.job) ?? candidate.job.applyUrl;
      const baseResult = {
        jobId: candidate.job.id,
        company: candidate.job.company,
        title: candidate.job.title,
        targetUrl: entryTargetUrl
      };
      try {
        const prepared = await ensureReadyToApplyJob(pipeline, candidate.job.id);
        const draft = prepared.application;
        if (draft == null) {
          throw new Error(`Application draft missing for job ${candidate.job.id}.`);
        }
        const workflowTargetUrl = resolveLinkedInAutoApplyTargetUrl(prepared.job);
        if (workflowTargetUrl == null) {
          throw new Error(
            "Autoapply currently supports LinkedIn job postings only. This job does not have a usable LinkedIn job URL in applyUrl or metadata.discoveryApplyUrl."
          );
        }
        const osInput = options.mode === "pyautogui" ? new WindowsOsInputDriver(options.osDryRun) : undefined;
        const page = await openWorkflowPage(context, workflowTargetUrl);
        const pagesToClose = new Set<Page>([page]);
        try {
          if (options.waitMs > 0) {
            await page.waitForTimeout(options.waitMs).catch(() => undefined);
          }
          let entry = await resolveApplicationEntry(context, page, osInput);
          let workflowPage = entry.page;
          pagesToClose.add(workflowPage);
          const loginResult = await attemptLoginSignupAndOtp(
            workflowPage,
            options.loginProfile,
            options.otpSettings,
            osInput
          );
          entry = await resumeApplicationEntryAfterAuth(context, workflowPage, entry.route, osInput);
          workflowPage = entry.page;
          pagesToClose.add(workflowPage);
          await assertResolvedAuthSurface(workflowPage);
          entry = await resumeApplicationEntryAfterAuth(context, workflowPage, entry.route, osInput);
          workflowPage = entry.page;
          pagesToClose.add(workflowPage);
          const autofill = await runProgressiveAutofill(
            workflowPage,
            draft,
            options.resumePath,
            options.additionalAnswers,
            entry.route,
            osInput,
            undefined
          );
          const blockerLabel = await detectAutofillBlocker(workflowPage);
          const pageErrors = await collectDebugPageErrors(workflowPage);

          const submitted = options.submit ? await attemptApplicationSubmit(workflowPage, osInput) : false;
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
              entryRoute: entry.route,
              resumeUploaded: autofill.resumeUploaded,
              roleAnswersUsed: autofill.roleAnswersUsed,
              missingKeys: autofill.missingKeys,
              loginAttempted: loginResult.loginAttempted,
              accountCreated: loginResult.accountCreated,
              otpCodeUsed: loginResult.otpCodeUsed,
              osInputActions: osInput?.actions,
              pageErrors
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
              entryRoute: entry.route,
              resumeUploaded: autofill.resumeUploaded,
              roleAnswersUsed: autofill.roleAnswersUsed,
              missingKeys: autofill.missingKeys,
              loginAttempted: loginResult.loginAttempted,
              accountCreated: loginResult.accountCreated,
              otpCodeUsed: loginResult.otpCodeUsed,
              osInputActions: osInput?.actions,
              pageErrors,
              message: options.submit
                ? "Submit was attempted but confirmation was not detected."
                : buildAutofillStatusMessage(autofill, "final submit was not attempted.", blockerLabel)
            });
          }
        } finally {
          for (const openPage of pagesToClose) {
            await openPage.close().catch(() => undefined);
          }
        }
      } catch (error) {
        results.push({
          ...baseResult,
          outcome: "failed",
          resumeUploaded: false,
          roleAnswersUsed: 0,
          missingKeys: [],
          pageErrors: [],
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

function buildTestDraft(targetUrl: string): ApplicationDraft {
  const identity = resolveAutoApplyIdentity();
  return {
    jobId: 0,
    targetUrl,
    answers: {
      full_name: identity.fullName,
      email: identity.email,
      phone: identity.phone,
      location: identity.location,
      linkedin: identity.linkedin,
      github: identity.github,
      portfolio: identity.portfolio
    },
    roleSpecificAnswers: [],
    reviewRequired: true,
    status: "drafted",
    generatedAt: new Date().toISOString()
  };
}

async function runAutoApplySingle(options: AutoApplySingleRunOptions): Promise<AutoApplyJobResult> {
  if (options.jobId == null && (options.targetUrl == null || options.targetUrl.trim().length === 0)) {
    throw new Error("Single-run autoapply requires --job-id or --url.");
  }

  const pipeline = new CareerOpsPipeline(rootDir, dbPath);
  let context: BrowserContext | null = null;
  let jobId = options.jobId ?? 0;
  let company = "Manual test";
  let title = "Autoapply test";
  let targetUrl = options.targetUrl ?? "";
  let debugSession: AutoApplyDebugSession | null = null;
  let activePage: Page | null = null;
  try {
    let draft: ApplicationDraft;
    if (options.jobId != null) {
      const prepared = await ensureReadyToApplyJob(pipeline, options.jobId);
      const preparedDraft = prepared.application;
      if (preparedDraft == null) {
        throw new Error(`Application draft missing for job ${options.jobId}.`);
      }
      draft = preparedDraft;
      jobId = prepared.job.id;
      company = prepared.job.company;
      title = prepared.job.title;
      const workflowTargetUrl = resolveLinkedInAutoApplyTargetUrl(prepared.job);
      if (workflowTargetUrl == null) {
        throw new Error(
          "Autoapply currently supports LinkedIn job postings only. This job does not have a usable LinkedIn job URL in applyUrl or metadata.discoveryApplyUrl."
        );
      }
      draft = {
        ...preparedDraft,
        targetUrl: workflowTargetUrl
      };
    } else {
      draft = buildTestDraft(options.targetUrl ?? "");
    }
    targetUrl = draft.targetUrl;
    debugSession = createAutoApplyDebugSession(options, jobId, targetUrl);

    mkdirSync(browserProfileDir, { recursive: true });
    context = await chromium.launchPersistentContext(browserProfileDir, {
      channel: "chrome",
      headless: options.headless
    });

    const osInput = options.mode === "pyautogui" ? new WindowsOsInputDriver(options.osDryRun) : undefined;
    const page = await openWorkflowPage(context, draft.targetUrl);
    activePage = page;
    const pagesToClose = new Set<Page>([page]);
    try {
      await captureAutoApplyDebugSnapshot(debugSession, page, "opened-target-page", {
        jobId,
        company,
        title,
        targetUrl: draft.targetUrl,
        mode: options.mode,
        osDryRun: options.osDryRun
      });
      if (options.waitMs > 0) {
        await page.waitForTimeout(options.waitMs).catch(() => undefined);
      }
      let entry = await resolveApplicationEntry(context, page, osInput);
      let workflowPage = entry.page;
      activePage = workflowPage;
      pagesToClose.add(workflowPage);
      await captureAutoApplyDebugSnapshot(debugSession, workflowPage, "entry-resolved", {
        entryRoute: entry.route
      });

      const loginResult = await attemptLoginSignupAndOtp(
        workflowPage,
        options.loginProfile,
        options.otpSettings,
        osInput
      );
      entry = await resumeApplicationEntryAfterAuth(context, workflowPage, entry.route, osInput);
      workflowPage = entry.page;
      activePage = workflowPage;
      pagesToClose.add(workflowPage);
      await captureAutoApplyDebugSnapshot(debugSession, workflowPage, "post-login-check", {
        loginAttempted: loginResult.loginAttempted,
        accountCreated: loginResult.accountCreated,
        otpCodeUsed: loginResult.otpCodeUsed
      });
      await assertResolvedAuthSurface(workflowPage);
      entry = await resumeApplicationEntryAfterAuth(context, workflowPage, entry.route, osInput);
      workflowPage = entry.page;
      activePage = workflowPage;
      pagesToClose.add(workflowPage);
      const autofill = await runProgressiveAutofill(
        workflowPage,
        draft,
        options.resumePath,
        options.additionalAnswers,
        entry.route,
        osInput,
        debugSession
      );
      const blockerLabel = await detectAutofillBlocker(workflowPage);
      const pageErrors = await collectDebugPageErrors(workflowPage);
      await captureAutoApplyDebugSnapshot(debugSession, workflowPage, "post-autofill", {
        entryRoute: entry.route,
        missingKeys: autofill.missingKeys,
        roleAnswersUsed: autofill.roleAnswersUsed,
        resumeUploaded: autofill.resumeUploaded,
        unresolvedRequiredPrompts: autofill.unresolvedRequiredPrompts,
        pageErrors
      });

      const result: AutoApplyJobResult = {
        jobId,
        company,
        title,
        targetUrl: draft.targetUrl,
        outcome: "prefilled",
        entryRoute: entry.route,
        resumeUploaded: autofill.resumeUploaded,
        roleAnswersUsed: autofill.roleAnswersUsed,
        missingKeys: autofill.missingKeys,
        loginAttempted: loginResult.loginAttempted,
        accountCreated: loginResult.accountCreated,
        otpCodeUsed: loginResult.otpCodeUsed,
        osInputActions: osInput?.actions,
        debugArtifactsDir: debugSession?.runDir,
        pageErrors,
        message: buildAutofillStatusMessage(
          autofill,
          "final submit is intentionally disabled in autoapply-test.",
          blockerLabel
        )
      };
      finalizeAutoApplyDebugSession(debugSession, {
        jobId,
        company,
        title,
        targetUrl: draft.targetUrl,
        outcome: result.outcome,
        entryRoute: result.entryRoute,
        missingKeys: result.missingKeys,
        roleAnswersUsed: result.roleAnswersUsed,
        resumeUploaded: result.resumeUploaded,
        pageErrors: result.pageErrors,
        message: result.message
      });

      return result;
    } finally {
      for (const openPage of pagesToClose) {
        await openPage.close().catch(() => undefined);
      }
      activePage = null;
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const pageErrors = activePage != null ? await collectDebugPageErrors(activePage) : [];
    if (debugSession != null && activePage != null) {
      await captureAutoApplyDebugSnapshot(debugSession, activePage, "failed", {
        error: errorMessage,
        pageErrors
      });
    }
    const failed: AutoApplyJobResult = {
      jobId,
      company,
      title,
      targetUrl,
      outcome: "failed",
      resumeUploaded: false,
      roleAnswersUsed: 0,
      missingKeys: [],
      debugArtifactsDir: debugSession?.runDir,
      pageErrors,
      message: errorMessage
    };
    finalizeAutoApplyDebugSession(debugSession, {
      jobId,
      company,
      title,
      targetUrl,
      outcome: failed.outcome,
      pageErrors: failed.pageErrors,
      message: failed.message
    });
    return failed;
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
      if (await locator.count().catch(() => 0)) {
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
  .description("Bulk prefill shortlisted LinkedIn jobs with pyautogui-driven Apply/Easy Apply handling and optional submit")
  .option("--resume <path>", `resume file path (defaults to ${AUTOAPPLY_ENV_RESUME})`)
  .option("--info <path>", `optional JSON file with additional answer key/value pairs (defaults to ${AUTOAPPLY_ENV_INFO})`)
  .option("--submit", `attempt to submit forms automatically (can also use ${AUTOAPPLY_ENV_SUBMIT}=1)`)
  .option("--headless", "run browser in headless mode")
  .option("--mode <mode>", `interaction mode: pyautogui|playwright (defaults to ${AUTOAPPLY_ENV_MODE} or pyautogui)`)
  .option("--os-dry-run", `log intended OS mouse/keyboard actions without executing them (or set ${AUTOAPPLY_ENV_OS_DRY_RUN}=1)`)
  .option("--login-email <email>", `default login email (defaults to ${AUTOAPPLY_ENV_LOGIN_EMAIL} or profile email)`)
  .option("--login-password <password>", `default login password (defaults to ${AUTOAPPLY_ENV_LOGIN_PASSWORD})`)
  .option("--login-first-name <name>", `default signup first name (defaults to ${AUTOAPPLY_ENV_LOGIN_FIRST_NAME})`)
  .option("--login-last-name <name>", `default signup last name (defaults to ${AUTOAPPLY_ENV_LOGIN_LAST_NAME})`)
  .option("--allow-create-account", `if login fails, attempt account creation (or set ${AUTOAPPLY_ENV_ALLOW_CREATE_ACCOUNT}=1)`)
  .option("--otp-host <host>", `IMAP host for verification-code polling (defaults to ${AUTOAPPLY_ENV_OTP_HOST})`)
  .option("--otp-port <port>", `IMAP port (defaults to ${AUTOAPPLY_ENV_OTP_PORT})`)
  .option("--otp-secure <true|false>", `IMAP TLS toggle (defaults to ${AUTOAPPLY_ENV_OTP_SECURE} or true)`)
  .option("--otp-user <user>", `IMAP username (defaults to ${AUTOAPPLY_ENV_OTP_USER})`)
  .option("--otp-password <password>", `IMAP password/app-password (defaults to ${AUTOAPPLY_ENV_OTP_PASSWORD})`)
  .option("--otp-mailbox <name>", `IMAP mailbox name (defaults to ${AUTOAPPLY_ENV_OTP_MAILBOX} or INBOX)`)
  .option("--otp-timeout-ms <ms>", `OTP polling timeout (defaults to ${AUTOAPPLY_ENV_OTP_TIMEOUT_MS} or ${AUTOAPPLY_DEFAULT_OTP_TIMEOUT_MS})`)
  .option("--otp-poll-ms <ms>", `OTP polling interval (defaults to ${AUTOAPPLY_ENV_OTP_POLL_MS} or ${AUTOAPPLY_DEFAULT_OTP_POLL_MS})`)
  .option("--wait-ms <ms>", "settle delay after page load before filling", String(AUTOAPPLY_DEFAULT_WAIT_MS))
  .option("--limit <count>", "max shortlisted jobs to process", "0")
  .action(async (options: {
    resume?: string;
    info?: string;
    submit?: boolean;
    headless?: boolean;
    waitMs?: string;
    limit?: string;
    mode?: string;
    osDryRun?: boolean;
    loginEmail?: string;
    loginPassword?: string;
    loginFirstName?: string;
    loginLastName?: string;
    allowCreateAccount?: boolean;
    otpHost?: string;
    otpPort?: string;
    otpSecure?: string;
    otpUser?: string;
    otpPassword?: string;
    otpMailbox?: string;
    otpTimeoutMs?: string;
    otpPollMs?: string;
  }) => {
    const parsed = parseAutoApplyOptions(options);
    const summary = await runShortlistAutoApply(parsed);
    if (summary.processed === 0) {
      console.log("No shortlisted LinkedIn jobs found in statuses: shortlisted, resume_ready, ready_to_apply, in_review.");
      return;
    }
    console.log(JSON.stringify(summary, null, 2));
  });

program
  .command("autoapply-test")
  .description("Run a single LinkedIn autoapply test on one job id or one URL (final submit disabled)")
  .option("--job-id <id>", "job id from the local database")
  .option("--url <url>", "direct target URL for testing without a stored job")
  .option("--resume <path>", `resume file path (defaults to ${AUTOAPPLY_ENV_RESUME})`)
  .option("--info <path>", `optional JSON file with additional answer key/value pairs (defaults to ${AUTOAPPLY_ENV_INFO})`)
  .option("--headless", "run browser in headless mode")
  .option("--mode <mode>", `interaction mode: pyautogui|playwright (defaults to ${AUTOAPPLY_ENV_MODE} or pyautogui)`)
  .option("--os-dry-run", `log intended OS mouse/keyboard actions without executing them (or set ${AUTOAPPLY_ENV_OS_DRY_RUN}=1)`)
  .option("--login-email <email>", `default login email (defaults to ${AUTOAPPLY_ENV_LOGIN_EMAIL} or profile email)`)
  .option("--login-password <password>", `default login password (defaults to ${AUTOAPPLY_ENV_LOGIN_PASSWORD})`)
  .option("--login-first-name <name>", `default signup first name (defaults to ${AUTOAPPLY_ENV_LOGIN_FIRST_NAME})`)
  .option("--login-last-name <name>", `default signup last name (defaults to ${AUTOAPPLY_ENV_LOGIN_LAST_NAME})`)
  .option("--allow-create-account", `if login fails, attempt account creation (or set ${AUTOAPPLY_ENV_ALLOW_CREATE_ACCOUNT}=1)`)
  .option("--otp-host <host>", `IMAP host for verification-code polling (defaults to ${AUTOAPPLY_ENV_OTP_HOST})`)
  .option("--otp-port <port>", `IMAP port (defaults to ${AUTOAPPLY_ENV_OTP_PORT})`)
  .option("--otp-secure <true|false>", `IMAP TLS toggle (defaults to ${AUTOAPPLY_ENV_OTP_SECURE} or true)`)
  .option("--otp-user <user>", `IMAP username (defaults to ${AUTOAPPLY_ENV_OTP_USER})`)
  .option("--otp-password <password>", `IMAP password/app-password (defaults to ${AUTOAPPLY_ENV_OTP_PASSWORD})`)
  .option("--otp-mailbox <name>", `IMAP mailbox name (defaults to ${AUTOAPPLY_ENV_OTP_MAILBOX} or INBOX)`)
  .option("--otp-timeout-ms <ms>", `OTP polling timeout (defaults to ${AUTOAPPLY_ENV_OTP_TIMEOUT_MS} or ${AUTOAPPLY_DEFAULT_OTP_TIMEOUT_MS})`)
  .option("--otp-poll-ms <ms>", `OTP polling interval (defaults to ${AUTOAPPLY_ENV_OTP_POLL_MS} or ${AUTOAPPLY_DEFAULT_OTP_POLL_MS})`)
  .option("--no-debug-artifacts", "disable screenshot/HTML/JSON debug artifacts for this test run")
  .option("--debug-dir <path>", "optional output directory for autoapply-test artifacts")
  .option("--wait-ms <ms>", "settle delay after page load before filling", String(AUTOAPPLY_DEFAULT_WAIT_MS))
  .action(async (options: {
    jobId?: string;
    url?: string;
    resume?: string;
    info?: string;
    headless?: boolean;
    waitMs?: string;
    mode?: string;
    osDryRun?: boolean;
    loginEmail?: string;
    loginPassword?: string;
    loginFirstName?: string;
    loginLastName?: string;
    allowCreateAccount?: boolean;
    otpHost?: string;
    otpPort?: string;
    otpSecure?: string;
    otpUser?: string;
    otpPassword?: string;
    otpMailbox?: string;
    otpTimeoutMs?: string;
    otpPollMs?: string;
    debugArtifacts?: boolean;
    debugDir?: string;
  }) => {
    const parsed = parseAutoApplySingleOptions(options);
    const result = await runAutoApplySingle(parsed);
    console.log(JSON.stringify(result, null, 2));
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
