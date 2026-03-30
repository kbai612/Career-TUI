import { describe, expect, it } from "vitest";
import {
  classifyLinkedInEntryCandidate,
  escapeSendKeysLiteral,
  extractOtpCodeFromText,
  extractVerificationUrlFromText,
  isAutofillTrapText,
  normalizeAutoApplyMode,
  pickBestLinkedInEntryCandidate,
  resolveLinkedInJobPostingUrl,
  scoreLinkedInEntryCandidate,
  splitName
} from "../src/autoapply-utils";

describe("autoapply utils", () => {
  it("splits a full name into first and last name", () => {
    expect(splitName("Kevin Bai")).toEqual({
      firstName: "Kevin",
      lastName: "Bai"
    });
  });

  it("escapes sendkeys reserved characters", () => {
    expect(escapeSendKeysLiteral("a+b^(c){d}%")).toBe("a{+}b{^}{(}c{)}{{}d{}}{%}");
  });

  it("maps legacy os mode to pyautogui", () => {
    expect(normalizeAutoApplyMode("os")).toBe("pyautogui");
    expect(normalizeAutoApplyMode(undefined)).toBe("pyautogui");
  });

  it("prefers discovery LinkedIn URLs over canonical external apply URLs", () => {
    expect(resolveLinkedInJobPostingUrl(
      "https://company.example/jobs/123",
      {
        discoveryApplyUrl: "https://www.linkedin.com/jobs/view/1234567890/"
      },
      "https://www.linkedin.com/jobs/search/?keywords=data"
    )).toBe("https://www.linkedin.com/jobs/view/1234567890/");
  });

  it("returns null when no LinkedIn job posting URL is available", () => {
    expect(resolveLinkedInJobPostingUrl(
      "https://company.example/jobs/123",
      undefined,
      "https://www.linkedin.com/jobs/search/?keywords=data"
    )).toBeNull();
  });

  it("classifies and prioritizes the primary offsite LinkedIn apply CTA over sidebar easy apply cards", () => {
    const primaryApply = {
      text: "Apply",
      ariaLabel: "Apply on company website",
      href: "https://www.linkedin.com/safety/go/?url=https%3A%2F%2Fjobs.example.com%2F123",
      className: "top-card-layout__cta--primary",
      id: "",
      dataTrackingControlName: "",
      top: 294,
      left: 94,
      width: 81,
      height: 32,
      viewportHeight: 1080,
      ancestorHints: ["top-card-layout__cta-container", "top-card-layout__entity-info"]
    };
    const sidebarEasyApply = {
      text: "Data Scientist Posted on March 19, 2026 · Easy Apply",
      ariaLabel: "",
      href: "https://www.linkedin.com/jobs/collections/similar-jobs/?currentJobId=4387702931",
      className: "job-card-container",
      id: "",
      dataTrackingControlName: "",
      top: 720,
      left: 337,
      width: 256,
      height: 231,
      viewportHeight: 1080,
      ancestorHints: ["jobs-box", "similar-jobs"]
    };

    expect(classifyLinkedInEntryCandidate(primaryApply)).toBe("apply");
    expect(classifyLinkedInEntryCandidate(sidebarEasyApply)).toBe("easy_apply");
    expect(scoreLinkedInEntryCandidate(primaryApply)).toBeGreaterThan(scoreLinkedInEntryCandidate(sidebarEasyApply));
    expect(pickBestLinkedInEntryCandidate([sidebarEasyApply, primaryApply])?.kind).toBe("apply");
  });

  it("prefers the primary easy apply CTA when it is the visible top-card action", () => {
    const primaryEasyApply = {
      text: "Easy Apply",
      ariaLabel: "Easy Apply to Senior Data Analyst at Mistplay",
      href: "https://www.linkedin.com/jobs/view/4363003707/apply/?openSDUIApplyFlow=true",
      className: "top-card-layout__cta--primary",
      id: "topbar-apply",
      dataTrackingControlName: "apply-link-onsite",
      top: 188,
      left: 94,
      width: 108,
      height: 32,
      viewportHeight: 1080,
      ancestorHints: ["top-card-layout__cta-container", "jobs-unified-top-card"]
    };

    expect(classifyLinkedInEntryCandidate(primaryEasyApply)).toBe("easy_apply");
    expect(pickBestLinkedInEntryCandidate([primaryEasyApply])?.kind).toBe("easy_apply");
  });

  it("extracts verification codes from keyword-rich content", () => {
    const email = "Use verification code 742991 to continue your login.";
    expect(extractOtpCodeFromText(email)).toBe("742991");
  });

  it("extracts numeric codes from html emails", () => {
    const html = "<html><body><p>Your sign-in code is <b>113355</b>.</p></body></html>";
    expect(extractOtpCodeFromText(html)).toBe("113355");
  });

  it("returns null when no candidate code is present", () => {
    expect(extractOtpCodeFromText("Hello there, no numbers here.")).toBeNull();
  });

  it("extracts activation links from quoted-printable verification emails", () => {
    const email = [
      "Subject: Verify your candidate account",
      "Click the link below to verify your account:",
      "https://td.wd3.myworkdayjobs.com/TD_Bank_Careers/activate/=3Ftoken=3Dabc123=26source=3Demail"
    ].join("\r\n");
    expect(extractVerificationUrlFromText(email)).toBe(
      "https://td.wd3.myworkdayjobs.com/TD_Bank_Careers/activate/?token=abc123&source=email"
    );
  });

  it("detects honeypot prompts that should never be auto-filled", () => {
    expect(isAutofillTrapText("Enter website. This input is for robots only, do not enter if you're human.")).toBe(true);
    expect(isAutofillTrapText("Portfolio website")).toBe(false);
  });
});
