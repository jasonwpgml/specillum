// The station is the one real Chrome that every pod shares. It runs with a
// dedicated profile, so logins made there are live for every agent.
import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, rmSync, statSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { chromium, type Browser } from "playwright-core";

export const port = Number(process.env.SPECILLUM_PORT ?? 9333);

export function profileDir(): string {
  if (process.env.SPECILLUM_PROFILE) return process.env.SPECILLUM_PROFILE;
  switch (platform()) {
    case "win32":
      return join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "specillum", "profile");
    case "darwin":
      return join(homedir(), "Library", "Application Support", "specillum", "profile");
    default:
      return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "specillum", "profile");
  }
}

function findChrome(): string {
  if (process.env.SPECILLUM_CHROME) return process.env.SPECILLUM_CHROME;
  const candidates: string[] = [];
  if (platform() === "win32") {
    for (const base of [process.env.ProgramFiles, process.env["ProgramFiles(x86)"], process.env.LOCALAPPDATA]) {
      if (!base) continue;
      candidates.push(join(base, "Google", "Chrome", "Application", "chrome.exe"));
      candidates.push(join(base, "Microsoft", "Edge", "Application", "msedge.exe"));
    }
  } else if (platform() === "darwin") {
    candidates.push(
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
    );
  } else {
    candidates.push(
      "/usr/bin/google-chrome",
      "/usr/bin/google-chrome-stable",
      "/usr/bin/chromium",
      "/usr/bin/chromium-browser",
      "/usr/bin/microsoft-edge",
    );
  }
  const found = candidates.find((p) => existsSync(p));
  if (!found) throw new Error("Chrome not found. Set SPECILLUM_CHROME to the browser executable path.");
  return found;
}

async function isUp(): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1000) });
    return res.ok;
  } catch {
    return false;
  }
}

async function waitUntilUp(): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (await isUp()) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Station did not open its debugging port ${port} within 20s.`);
}

// Starts the station if it is not running. When several pods start at once, a
// lock file lets only one of them launch Chrome; the rest wait for the port.
export async function ensureStation(): Promise<void> {
  if (await isUp()) return;
  const dir = profileDir();
  mkdirSync(dir, { recursive: true });
  const lock = `${dir}.lock`;
  try {
    closeSync(openSync(lock, "wx"));
  } catch {
    if (Date.now() - statSync(lock).mtimeMs < 30_000) return waitUntilUp();
    // A stale lock from a launch that died; take it over.
  }
  try {
    launchChrome(dir);
    await waitUntilUp();
  } finally {
    rmSync(lock, { force: true });
  }
}

function launchChrome(dir: string): void {
  const child = spawn(
    findChrome(),
    [
      `--remote-debugging-port=${port}`,
      "--remote-debugging-address=127.0.0.1",
      `--user-data-dir=${dir}`,
      "--no-first-run",
      "--no-default-browser-check",
      // Minimized and hidden pods are background pages; keep their timers and
      // rendering at full speed so sites behave as in a focused tab.
      "--disable-background-timer-throttling",
      "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding",
    ],
    { detached: true, stdio: "ignore" },
  );
  child.unref();
}

export async function connectStation(): Promise<Browser> {
  await ensureStation();
  // noDefaults keeps Playwright from rewriting the station's own settings,
  // such as redirecting every download in the profile to a temp folder.
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { noDefaults: true });
  // Playwright auto-dismisses dialogs on any page it sees that has no dialog
  // listener. Every pod's connection sees every page, so without this one
  // agent would silently close dialogs in the user's tabs and in other pods.
  browser.contexts()[0]?.on("dialog", () => {});
  return browser;
}
