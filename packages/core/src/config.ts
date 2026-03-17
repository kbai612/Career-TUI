import { readFileSync } from "node:fs";
import path from "node:path";
import type { ArchetypeConfig, ProfilePack, ScoringConfig } from "./types";

function readJsonFile<T>(filePath: string): T {
  return JSON.parse(readFileSync(filePath, "utf8")) as T;
}

export function resolveProjectPath(rootDir: string, ...parts: string[]): string {
  return path.resolve(rootDir, ...parts);
}

export function loadScoringConfig(rootDir: string): ScoringConfig {
  return readJsonFile<ScoringConfig>(resolveProjectPath(rootDir, "config", "scoring.json"));
}

export function loadArchetypeConfig(rootDir: string): ArchetypeConfig {
  return readJsonFile<ArchetypeConfig>(resolveProjectPath(rootDir, "config", "archetypes.json"));
}

export function loadProfilePack(rootDir: string): ProfilePack {
  const profile = readJsonFile<Omit<ProfilePack, "masterResume">>(resolveProjectPath(rootDir, "profile", "profile.json"));
  const masterResume = readFileSync(resolveProjectPath(rootDir, "profile", "master_resume.md"), "utf8");
  return { ...profile, masterResume };
}

export function ensureDataPaths(rootDir: string): { dataDir: string; dbPath: string; browserProfileDir: string } {
  const dataDir = resolveProjectPath(rootDir, "data");
  const dbPath = process.env.CAREER_OPS_DB_PATH
    ? path.resolve(rootDir, process.env.CAREER_OPS_DB_PATH)
    : path.resolve(dataDir, "career-ops.db");
  const browserProfileDir = process.env.CAREER_OPS_BROWSER_PROFILE
    ? path.resolve(rootDir, process.env.CAREER_OPS_BROWSER_PROFILE)
    : path.resolve(dataDir, "browser-profile");
  return { dataDir, dbPath, browserProfileDir };
}
