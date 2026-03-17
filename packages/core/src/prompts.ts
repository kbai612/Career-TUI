import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { ModeName } from "./types";

export function getPromptPath(mode: ModeName): string {
  const candidates = [
    path.resolve(__dirname, "..", "prompts", `${mode}.md`),
    path.resolve(__dirname, "..", "..", "prompts", `${mode}.md`),
    path.resolve(process.cwd(), "packages", "core", "prompts", `${mode}.md`)
  ];
  const match = candidates.find((candidate) => existsSync(candidate));
  return match ?? candidates[0];
}

export function loadPrompt(mode: ModeName): string {
  const promptPath = getPromptPath(mode);
  if (!existsSync(promptPath)) {
    throw new Error(`Missing prompt file for mode ${mode}: ${promptPath}`);
  }
  return readFileSync(promptPath, "utf8");
}

export function ensureDirectory(dirPath: string): void {
  if (!existsSync(dirPath)) {
    mkdirSync(dirPath, { recursive: true });
  }
}
