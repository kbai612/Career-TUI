import { describe, expect, it } from "vitest";
import { buildOpenUrlCommand } from "../src/browser";

describe("buildOpenUrlCommand", () => {
  it("builds a Windows browser launch command", () => {
    expect(buildOpenUrlCommand("https://example.com/job", "win32")).toEqual({
      command: "cmd",
      args: ["/c", "start", "", "https://example.com/job"]
    });
  });

  it("builds a macOS browser launch command", () => {
    expect(buildOpenUrlCommand("https://example.com/job", "darwin")).toEqual({
      command: "open",
      args: ["https://example.com/job"]
    });
  });

  it("builds a Linux browser launch command", () => {
    expect(buildOpenUrlCommand("https://example.com/job", "linux")).toEqual({
      command: "xdg-open",
      args: ["https://example.com/job"]
    });
  });
});
