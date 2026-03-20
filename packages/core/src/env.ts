import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

function resolveValue(rawValue: string): string {
  const trimmed = rawValue.trim();
  if ((trimmed.startsWith("\"") && trimmed.endsWith("\"")) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    const quote = trimmed[0];
    const unquoted = trimmed.slice(1, -1);
    if (quote === "\"") {
      return unquoted
        .replace(/\\n/g, "\n")
        .replace(/\\r/g, "\r")
        .replace(/\\t/g, "\t")
        .replace(/\\"/g, "\"")
        .replace(/\\\\/g, "\\");
    }
    return unquoted.replace(/\\'/g, "'").replace(/\\\\/g, "\\");
  }
  return trimmed.replace(/\s+#.*$/, "").trimEnd();
}

function parseEnvLine(line: string): { key: string; value: string } | null {
  const trimmed = line.trim();
  if (trimmed.length === 0 || trimmed.startsWith("#")) {
    return null;
  }

  const withoutExport = trimmed.startsWith("export ")
    ? trimmed.slice("export ".length).trimStart()
    : trimmed;
  const separatorIndex = withoutExport.indexOf("=");
  if (separatorIndex <= 0) {
    return null;
  }

  const key = withoutExport.slice(0, separatorIndex).trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
    return null;
  }
  const rawValue = withoutExport.slice(separatorIndex + 1);
  return { key, value: resolveValue(rawValue) };
}

export function loadRootEnv(rootDir: string): void {
  const envPath = path.resolve(rootDir, ".env");
  if (!existsSync(envPath)) {
    return;
  }

  const content = readFileSync(envPath, "utf8");
  for (const line of content.split(/\r?\n/)) {
    const parsed = parseEnvLine(line);
    if (parsed == null) {
      continue;
    }
    const existingValue = process.env[parsed.key];
    if (existingValue == null || existingValue.trim().length === 0) {
      process.env[parsed.key] = parsed.value;
    }
  }
}
