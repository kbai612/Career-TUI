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
        report.executiveSummary,
        `Grade ${report.grade} fit for ${job.title} with emphasis on ${report.personalization.summaryFocus.toLowerCase()}.`,
        `ATS keywords: ${report.personalization.keywords.slice(0, 6).join(", ") || "automation, evaluation, and agent systems"}.`
      ]
    },
    {
      heading: "Selected Proof Points",
      bullets: report.cvMatches.slice(0, 4).map((match) => `${match.requirement} Evidence: ${match.proofPoint}`)
    },
    {
      heading: "Core Skills",
      bullets: profile.skills.slice(0, 8).map((skill) => `${skill} used in production delivery and workflow automation.`)
    },
    {
      heading: "Projects To Lead With",
      bullets: report.personalization.recommendedProjects.map((project) => `${project} Relevant to ${job.company}'s ${job.title} role.`)
    }
  ];
}

function renderDocumentHtml(title: string, summary: string, sections: ResumeSection[], profile: ProfilePack, pageFormat: "Letter" | "A4"): string {
  const sectionHtml = sections
    .map((section) => `<section><h2>${section.heading}</h2><ul>${section.bullets.map((bullet) => `<li>${bullet}</li>`).join("")}</ul></section>`)
    .join("");

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>${title}</title>
  <style>
    @page { size: ${pageFormat}; margin: 18mm; }
    body { font-family: "Helvetica Neue", Helvetica, Arial, sans-serif; margin: 0; color: #111; }
    main { max-width: 780px; margin: 0 auto; }
    header { border-bottom: 2px solid #111; margin-bottom: 18px; padding-bottom: 12px; }
    h1 { font-size: 26px; margin: 0 0 4px; }
    h2 { font-size: 13px; margin: 14px 0 8px; text-transform: uppercase; letter-spacing: 0.08em; }
    p, li { font-size: 11px; line-height: 1.5; }
    ul { padding-left: 18px; margin: 0; }
    .meta { font-size: 10px; color: #444; }
    .summary { margin: 14px 0 18px; }
    section { break-inside: avoid; margin-bottom: 12px; }
  </style>
</head>
<body>
  <main>
    <header>
      <h1>${profile.name}</h1>
      <div class="meta">${profile.email} | ${profile.phone} | ${profile.location}</div>
      <div class="meta">${profile.linkedin ?? ""} ${profile.github ?? ""} ${profile.portfolio ?? ""}</div>
    </header>
    <p class="summary">${summary}</p>
    ${sectionHtml}
  </main>
</body>
</html>`;
}

function renderCoverLetterHtml(job: JobListing, report: EvaluationReport, profile: ProfilePack): string {
  const body = [
    `Dear hiring team,`,
    ``,
    `I am applying for the ${job.title} role at ${job.company}. The role maps directly to my work building agentic systems, evaluation pipelines, and browser automation with explicit human-in-the-loop controls.`,
    ``,
    `The most relevant proof point is ${profile.proofPoints[0]} I would frame my contribution around ${report.personalization.summaryFocus.toLowerCase()} and the concrete evidence captured in the tailored resume.`,
    ``,
    `What stands out about this role is the combination of ${report.strongestSignals.join(", ").toLowerCase()} and the chance to apply those strengths in production. I also understand the current risks: ${report.riskSignals[0] ?? "execution context needs validation"}.`,
    ``,
    `I would welcome the chance to discuss how that background could translate into fast, measurable impact for ${job.company}.`,
    ``,
    `Best regards,`,
    profile.name
  ].join("<br />");

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Cover Letter - ${job.company}</title>
  <style>
    @page { size: ${report.personalization.format}; margin: 18mm; }
    body { font-family: Georgia, "Times New Roman", serif; color: #111; margin: 0; }
    main { max-width: 760px; margin: 0 auto; }
    header { margin-bottom: 24px; }
    h1 { font-size: 22px; margin: 0 0 6px; }
    .meta { font-size: 11px; color: #444; }
    p { font-size: 12px; line-height: 1.65; }
    .panel { border-top: 1px solid #111; padding-top: 18px; }
  </style>
</head>
<body>
  <main>
    <header>
      <h1>${profile.name}</h1>
      <div class="meta">${profile.email} | ${profile.phone} | ${profile.location}</div>
    </header>
    <div class="panel">
      <p>${body}</p>
    </div>
  </main>
</body>
</html>`;
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

export function buildResumeVariant(jobId: number, outputDir: string, job: JobListing, report: EvaluationReport, profile: ProfilePack): ResumeVariant {
  ensureDirectory(outputDir);
  const sections = buildSections(job, report, profile);
  const summary = `${profile.summary} Tailored for ${job.title} at ${job.company}, emphasizing ${report.personalization.summaryFocus.toLowerCase()}.`;
  const html = renderDocumentHtml(job.title, summary, sections, profile, report.personalization.format);
  const plainText = stripHtml(html);
  const coverLetterHtml = renderCoverLetterHtml(job, report, profile);
  const coverLetterPlainText = stripHtml(coverLetterHtml);
  const fileStem = `${sanitizeFileName(job.company)}-${sanitizeFileName(job.title)}`;
  const pdfPath = path.resolve(outputDir, `${fileStem}.pdf`);
  const htmlPath = path.resolve(outputDir, `${fileStem}.html`);
  const coverLetterHtmlPath = path.resolve(outputDir, `${fileStem}-cover-letter.html`);
  const coverLetterPdfPath = path.resolve(outputDir, `${fileStem}-cover-letter.pdf`);
  writeFileSync(htmlPath, html, "utf8");
  writeFileSync(coverLetterHtmlPath, coverLetterHtml, "utf8");

  return {
    jobId,
    title: job.title,
    targetCompany: job.company,
    summary,
    keywords: report.personalization.keywords,
    sections,
    plainText,
    html,
    htmlPath,
    pdfPath,
    coverLetterPlainText,
    coverLetterHtml,
    coverLetterHtmlPath,
    coverLetterPdfPath,
    generatedAt: new Date().toISOString()
  };
}

export async function renderResumePdf(variant: ResumeVariant): Promise<void> {
  if (process.env.CAREER_OPS_SKIP_PDF_RENDER === "1") {
    return;
  }
  const browser = await chromium.launch({ headless: true });
  try {
    const resumePage = await browser.newPage();
    await resumePage.setContent(variant.html, { waitUntil: "load" });
    await resumePage.pdf({
      path: variant.pdfPath,
      preferCSSPageSize: true,
      margin: { top: "20px", right: "20px", bottom: "20px", left: "20px" },
      printBackground: false
    });

    const coverLetterPage = await browser.newPage();
    await coverLetterPage.setContent(variant.coverLetterHtml, { waitUntil: "load" });
    await coverLetterPage.pdf({
      path: variant.coverLetterPdfPath,
      preferCSSPageSize: true,
      margin: { top: "20px", right: "20px", bottom: "20px", left: "20px" },
      printBackground: false
    });
  } finally {
    await browser.close();
  }
}

