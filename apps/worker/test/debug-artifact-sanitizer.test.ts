import { describe, expect, it } from "vitest";
import { sanitizeDebugArtifactText } from "../src/debug-artifact-sanitizer";

describe("debug artifact sanitizer", () => {
  it("redacts browser-exposed third-party keys from debug artifacts", () => {
    const artifact = [
      '<script>window.ENV={"GOOGLE_PICKER_DEVELOPER_KEY":"AIzaSyBeoz4WOjOsy8ZJFIkkQBvL8BZQCzLplHQ","GOOGLE_PICKER_CLIENT_ID":"594601915089-7c2994029qkt5qu2tmbppujr9jqrqqrs.apps.googleusercontent.com","GOOGLE_PICKER_APP_ID":"594601915089","DROPBOX_CHOOSER_API_KEY":"mh9jyh4mfwjnfhj","GOOGLE_RECAPTCHA_INVISIBLE_KEY":"6LfmcbcpAAAAAChNTbhUShzUOAMj_wY9LQIvLFX0"}</script>',
      '<script src="https://www.recaptcha.net/recaptcha/enterprise.js?render=6LfmcbcpAAAAAChNTbhUShzUOAMj_wY9LQIvLFX0"></script>',
      '<iframe src="https://www.recaptcha.net/recaptcha/enterprise/anchor?ar=1&amp;k=6LfmcbcpAAAAAChNTbhUShzUOAMj_wY9LQIvLFX0"></iframe>',
      '<script id="dropboxjs" data-app-key="mh9jyh4mfwjnfhj"></script>'
    ].join("\n");

    const sanitized = sanitizeDebugArtifactText(artifact);

    expect(sanitized).not.toContain("AIzaSyBeoz4WOjOsy8ZJFIkkQBvL8BZQCzLplHQ");
    expect(sanitized).not.toContain("6LfmcbcpAAAAAChNTbhUShzUOAMj_wY9LQIvLFX0");
    expect(sanitized).not.toContain("mh9jyh4mfwjnfhj");
    expect(sanitized).toContain('"GOOGLE_PICKER_DEVELOPER_KEY":"[REDACTED]"');
    expect(sanitized).toContain('render=[REDACTED]');
    expect(sanitized).toContain('&amp;k=[REDACTED]');
    expect(sanitized).toContain('data-app-key="[REDACTED]"');
  });
});
