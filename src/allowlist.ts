// With SPECILLUM_ALLOWED_DOMAINS set, a pod's tabs and iframes may only open
// these sites and their subdomains. about:blank stays open, since every window
// starts there; data:, file: and chrome: pages do not.
import type { Page } from "playwright-core";
import { redactUrl } from "./data.js";

const ALLOWED = process.env.SPECILLUM_ALLOWED_DOMAINS?.split(",").map((d) => d.trim().toLowerCase()).filter(Boolean);

export function onSite(url: string, site: string): boolean {
  try {
    const { protocol, hostname } = new URL(url);
    return (protocol === "https:" || protocol === "http:") && (hostname === site || hostname.endsWith(`.${site}`));
  } catch {
    return false;
  }
}

const allowedUrl = (url: string) => !ALLOWED || url.startsWith("about:") || ALLOWED.some((site) => onSite(url, site));

export function assertAllowed(url: string): void {
  if (!allowedUrl(url)) throw new Error(`${redactUrl(url)} is outside SPECILLUM_ALLOWED_DOMAINS (${ALLOWED!.join(", ")}).`);
}

// Blocks a navigation before it leaves, and sends the tab away if one got past
// the route: a popup that started before it was installed, or a history step
// served from the back/forward cache. The route costs the tab its HTTP cache,
// so it is only installed when the allowlist is in use. "aborted" keeps the tab
// on its page, where other failure codes would load an error page instead.
export async function guardPage(page: Page, note: (message: string) => void): Promise<void> {
  if (!ALLOWED) return;
  const refuse = (url: string) => note(`blocked ${redactUrl(url)}: outside SPECILLUM_ALLOWED_DOMAINS`);
  await page.route("**/*", (route, req) => {
    if (!req.isNavigationRequest() || allowedUrl(req.url())) return route.fallback();
    refuse(req.url());
    return route.abort("aborted");
  });
  const check = (url: string) => {
    if (allowedUrl(url)) return;
    refuse(url);
    void page.goto("about:blank").catch(() => {});
  };
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) check(frame.url());
  });
  check(page.url());
}
