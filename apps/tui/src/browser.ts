import { spawn } from "node:child_process";

export interface OpenUrlCommand {
  command: string;
  args: string[];
}

export function buildOpenUrlCommand(url: string, platform: NodeJS.Platform = process.platform): OpenUrlCommand {
  switch (platform) {
    case "win32":
      return { command: "cmd", args: ["/c", "start", "", url] };
    case "darwin":
      return { command: "open", args: [url] };
    default:
      return { command: "xdg-open", args: [url] };
  }
}

export async function openExternalUrl(url: string): Promise<void> {
  const { command, args } = buildOpenUrlCommand(url);

  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      detached: true,
      stdio: "ignore",
      windowsHide: true
    });

    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}
