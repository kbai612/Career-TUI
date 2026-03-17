import { writeFileSync } from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import { ensureDirectory } from "./prompts";
import type { EvaluationReport, JobListing, ProfilePack, ResumeSection, ResumeVariant } from "./types";

function sanitizeFileName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function buildSections(job: JobListing, report: EvaluationReport, profile: ProfilePack): ResumeSection[] {
  return [
    {
      heading: "Target Alignment",
      bullets: [
        `Targeting ${job.title} roles with strongest fit in ${report.archetypeLabel}.`,
        `Matched job keywords: ${report.matchedKeywords.slice(0, 4).join(", ") || "agent systems, automation"}.`,
        `Proven ability to ship browser automation and agent orchestration with human review controls.`
      ]
    },
    {
      heading: "Core Skills",
      bullets: profile.skills.slice(0, 6).map((skill) => `${skill} used in production delivery and workflow automation.`)
    },
    {
      heading: "Proof Points",
      bullets: profile.proofPoints.map((point) => `${point} Relevant to ${job.company}'s ${job.title} role.`)
    }
  ];
}

function renderHtml(title: string, summary: string, sections: ResumeSection[], profile: ProfilePack): string {
  const sectionHtml = sections
    .map((section) => `<section><h2>${section.heading}</h2><ul>${section.bullets.map((bullet) => `<li>${bullet}</li>`).join("")}</ul></section>`)
    .join("");

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>${title}</title>
  <style>
    body { font-family: Helvetica, Arial, sans-serif; margin: 40px; color: #111; }
    header { border-bottom: 2px solid #111; margin-bottom: 18px; padding-bottom: 12px; }
    h1 { font-size: 26px; margin: 0 0 4px; }
    h2 { font-size: 15px; margin: 14px 0 8px; text-transform: uppercase; letter-spacing: 0.06em; }
    p, li { font-size: 11px; line-height: 1.5; }
    ul { padding-left: 18px; margin: 0; }
    .meta { font-size: 10px; color: #444; }
  </style>
</head>
<body>
  <header>
    <h1>${profile.name}</h1>
    <div class="meta">${profile.email} | ${profile.phone} | ${profile.location}</div>
    <div class="meta">${profile.linkedin ?? ""} ${profile.github ?? ""} ${profile.portfolio ?? ""}</div>
  </header>
  <p>${summary}</p>
  ${sectionHtml}
</body>
</html>`;
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

export function buildResumeVariant(jobId: number, outputDir: string, job: JobListing, report: EvaluationReport, profile: ProfilePack): ResumeVariant {
  ensureDirectory(outputDir);
  const sections = buildSections(job, report, profile);
  const summary = `${profile.summary} Tailored for ${job.title} at ${job.company}, emphasizing ${report.matchedKeywords.slice(0, 3).join(", ") || "automation and AI systems"}.`;
  const html = renderHtml(job.title, summary, sections, profile);
  const plainText = stripHtml(html);
  const fileStem = `${sanitizeFileName(job.company)}-${sanitizeFileName(job.title)}`;
  const pdfPath = path.resolve(outputDir, `${fileStem}.pdf`);
  const htmlPath = path.resolve(outputDir, `${fileStem}.html`);
  writeFileSync(htmlPath, html, "utf8");

  return {
    jobId,
    title: job.title,
    targetCompany: job.company,
    summary,
    keywords: report.matchedKeywords,
    sections,
    plainText,
    html,
    htmlPath,
    pdfPath,
    generatedAt: new Date().toISOString()
  };
}

export async function renderResumePdf(variant: ResumeVariant): Promise<void> {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(variant.html, { waitUntil: "load" });
    await page.pdf({
      path: variant.pdfPath,
      format: "Letter",
      margin: { top: "20px", right: "20px", bottom: "20px", left: "20px" },
      printBackground: false
    });
  } finally {
    await browser.close();
  }
}
