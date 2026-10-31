// A pod is one agent's private window inside the station. The pod only ever
// hands out pages it opened itself (or popups those pages opened), so an
// agent cannot see or touch the user's tabs or another agent's pod.
import type { Browser, BrowserContext, CDPSession, Page, Request } from "playwright-core";
import { isJsonType, redactUrl } from "./data.js";
import { onSite } from "./recipes.js";

const CONTENT_REQUESTS = new Set(["document", "script", "xhr", "fetch"]);

// A response one of the pod's pages received from a fetch or XHR. Only JSON
// bodies are kept, parsed, and only up to MAX_BODY characters.
export type Captured = {
  id: number;
  page: Page;
  method: string;
  url: string;
  status: number;
  contentType: string;
  json?: unknown;
  chars?: number;
  skipped?: string;
};
const MAX_CAPTURED = 150;
const MAX_BODY = 2_000_000;

export type LogEntry = { page: Page; level: string; text: string };
const MAX_LOGS = 200;
const MAX_LOG_CHARS = 500;

// With SPECILLUM_ALLOWED_DOMAINS set, a pod's tabs and iframes may only open
// these sites and their subdomains. about:blank stays open, since every window
// starts there; data:, file: and chrome: pages do not.
const ALLOWED = process.env.SPECILLUM_ALLOWED_DOMAINS?.split(",").map((d) => d.trim().toLowerCase()).filter(Boolean);
export const allowedUrl = (url: string) => !ALLOWED || url.startsWith("about:") || ALLOWED.some((site) => onSite(url, site));
export function assertAllowed(url: string): void {
  if (!allowedUrl(url)) throw new Error(`${redactUrl(url)} is outside SPECILLUM_ALLOWED_DOMAINS (${ALLOWED!.join(", ")}).`);
}

async function targetIdOf(context: BrowserContext, page: Page): Promise<string> {
  const session = await context.newCDPSession(page);
  try {
    const { targetInfo } = await session.send("Target.getTargetInfo");
    return targetInfo.targetId;
  } finally {
    await session.detach().catch(() => {});
  }
}

// visible: a normal window that opens without stealing focus.
// minimized: a window that starts in the taskbar; open it to watch or take over.
export type PodWindow = "visible" | "minimized";

// Without an explicit size Chrome opens a narrow window and many sites switch
// to their mobile layout.
const [WIDTH, HEIGHT] = (process.env.SPECILLUM_WINDOW ?? "1280x900").split("x").map(Number);

export class Pod {
  readonly pages: Page[] = [];
  private active: Page | undefined;

  private constructor(
    readonly label: string,
    readonly mode: PodWindow,
    private readonly context: BrowserContext,
    private readonly cdp: CDPSession,
  ) {
    this.windowState = mode === "minimized" ? "minimized" : "normal";
  }

  static async launch(browser: Browser, label: string, mode: PodWindow): Promise<Pod> {
    const context = browser.contexts()[0];
    if (!context) throw new Error("Station has no default browser context.");
    return new Pod(label, mode, context, await browser.newBrowserCDPSession());
  }

  // Opens a fresh window for the pod. Used for the first page and whenever the
  // agent has closed every page it had.
  private async openWindow(): Promise<Page> {
    const params =
      this.mode === "minimized"
        ? { url: "about:blank", newWindow: true, width: WIDTH, height: HEIGHT, windowState: "minimized" as const }
        : { url: "about:blank", newWindow: true, width: WIDTH, height: HEIGHT, focus: false };
    const waitForPage = new Promise<Page>((resolve, reject) => {
      let targetId = "";
      const onPage = async (page: Page) => {
        if (!targetId) return;
        if ((await targetIdOf(this.context, page).catch(() => "")) === targetId) {
          this.context.off("page", onPage);
          resolve(page);
        }
      };
      this.context.on("page", onPage);
      this.cdp.send("Target.createTarget", params).then((r) => {
        targetId = r.targetId;
        // The page event may have fired before targetId was known.
        for (const page of this.context.pages()) void onPage(page);
      }, reject);
    });
    const page = this.adopt(await waitForPage);
    await this.sessions.get(page);
    return page;
  }

  // What the pod's window should be. Chrome restores a minimized window when a
  // page in it opens a tab, so new tabs put it back.
  private windowState: "normal" | "minimized";

  async setWindowState(state: "normal" | "minimized"): Promise<void> {
    this.windowState = state;
    const session = await this.sessions.get(await this.page());
    if (session) await this.applyWindowState(session);
  }

  private async applyWindowState(session: CDPSession): Promise<void> {
    const { targetInfo } = await session.send("Target.getTargetInfo");
    const { windowId } = await this.cdp.send("Browser.getWindowForTarget", { targetId: targetInfo.targetId });
    await this.cdp.send("Browser.setWindowBounds", { windowId, bounds: { windowState: this.windowState } });
  }

  readonly captured: Captured[] = [];
  private nextCaptureId = 1;

  private async capture(page: Page, req: Request): Promise<void> {
    const res = await req.response().catch(() => null);
    if (!res) return;
    const contentType = (await res.headerValue("content-type").catch(() => null)) ?? "";
    const entry: Captured = { id: this.nextCaptureId++, page, method: req.method(), url: req.url(), status: res.status(), contentType };
    if (!isJsonType(contentType)) entry.skipped = "not JSON";
    else {
      const body = await res.text().catch(() => undefined);
      if (body === undefined) entry.skipped = "body unavailable";
      else if (body.length > MAX_BODY) entry.skipped = `too large (${body.length} chars)`;
      else {
        try {
          entry.json = JSON.parse(body);
          entry.chars = body.length;
        } catch {
          entry.skipped = "invalid JSON";
        }
      }
    }
    this.captured.push(entry);
    if (this.captured.length > MAX_CAPTURED) this.captured.shift();
  }

  // Requests that can still change the page, per pod page.
  private readonly inflight = new Map<Page, Map<Request, number>>();

  // One CDP session per pod page, kept for the page's lifetime.
  private readonly sessions = new Map<Page, Promise<CDPSession | undefined>>();

  readonly logs: LogEntry[] = [];

  private log(page: Page, level: string, text: string): void {
    this.logs.push({ page, level, text: text.slice(0, MAX_LOG_CHARS) });
    if (this.logs.length > MAX_LOGS) this.logs.shift();
  }

  // Blocks a navigation before it leaves, and sends the tab away if one got past
  // the route: a popup that started before it was installed, or a history step
  // served from the back/forward cache. The route costs the tab its HTTP cache,
  // so it is only installed when the allowlist is in use. "aborted" keeps the tab
  // on its page, where other failure codes would load an error page instead.
  private async guard(page: Page): Promise<void> {
    if (!ALLOWED) return;
    const refuse = (url: string) => this.notes.push(`blocked ${redactUrl(url)}: outside SPECILLUM_ALLOWED_DOMAINS`);
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

  // Chrome reports downloads on the page's own session, so nothing here touches
  // the station's download settings or sees other windows' files.
  private watchDownloads(session: CDPSession): void {
    const names = new Map<string, string>();
    session.on("Page.downloadWillBegin", ({ guid, suggestedFilename }) => {
      names.set(guid, suggestedFilename);
      this.notes.push(`download started: ${suggestedFilename}`);
    });
    session.on("Page.downloadProgress", ({ guid, state }) => {
      if (state === "inProgress") return;
      this.notes.push(`download ${state === "completed" ? "finished, in the station's download folder" : "canceled"}: ${names.get(guid) ?? guid}`);
      names.delete(guid);
    });
    void session.send("Page.enable").catch(() => {});
  }

  private adopt(page: Page): Page {
    if (this.pages.includes(page)) return page;
    this.pages.push(page);
    this.active = page;
    // A minimized window, or a pod window the user covered or put in the
    // background, stops rendering: animation frames never fire and every click
    // waits forever. Focus emulation keeps the page rendering as if focused.
    this.sessions.set(
      page,
      this.context.newCDPSession(page).then(async (s) => {
        await s.send("Emulation.setFocusEmulationEnabled", { enabled: true }).catch(() => {});
        if (this.windowState === "minimized") await this.applyWindowState(s).catch(() => {});
        this.watchDownloads(s);
        await this.guard(page).catch(() => {});
        return s;
      }).catch(() => undefined),
    );
    const inflight = new Map<Request, number>();
    this.inflight.set(page, inflight);
    const done = (r: Request) => inflight.delete(r);
    page.on("request", (r) => {
      if (CONTENT_REQUESTS.has(r.resourceType())) inflight.set(r, Date.now());
    });
    page.on("requestfinished", (r) => {
      done(r);
      if (r.resourceType() === "xhr" || r.resourceType() === "fetch") void this.capture(page, r);
    });
    page.on("requestfailed", done);
    page.on("console", (m) => this.log(page, m.type(), m.text()));
    page.on("pageerror", (e) => this.log(page, "error", `uncaught ${e.name}: ${e.message}`));
    page.on("popup", (popup) => {
      if (this.pages.includes(popup)) return;
      this.adopt(popup);
      this.notes.push(`page opened a new tab [${this.pages.indexOf(popup)}]; it is now the active tab`);
    });
    page.on("close", () => {
      const i = this.pages.indexOf(page);
      if (i >= 0) this.pages.splice(i, 1);
      if (this.active === page) this.active = this.pages.at(-1);
      this.sessions.delete(page);
      this.inflight.delete(page);
    });
    // A dialog blocks the page until answered. Alerts are accepted; confirms
    // and prompts are dismissed unless the agent armed an answer with the
    // dialog tool, so a "Delete this?" never gets a silent yes.
    page.on("dialog", (dialog) => {
      const armed = this.nextDialog;
      this.nextDialog = undefined;
      const type = dialog.type();
      const accept = armed ? armed.accept : type === "alert" || type === "beforeunload";
      const answered = (accept ? dialog.accept(armed?.promptText) : dialog.dismiss()).catch(() => {});
      this.pending.add(answered);
      void answered.then(() => this.pending.delete(answered));
      this.notes.push(`${type} dialog "${dialog.message()}" was ${accept ? "accepted" : "dismissed"}${armed ? "" : type === "confirm" || type === "prompt" ? " (use the dialog tool before the action to accept it)" : ""}`);
    });
    return page;
  }

  // Events the agent should hear about in the next tool result.
  readonly notes: string[] = [];
  nextDialog: { accept: boolean; promptText?: string } | undefined;
  private readonly pending = new Set<Promise<void>>();

  // Gives the page a moment to react to an action (open a popup, raise a
  // dialog), then waits for any dialog answer to land before reporting.
  // since is when the action started; without it (and with ms 0) there is no
  // wait for the network. Requests that were already open before the action
  // did not come from it, and some (cancelled navigations, beacons) never
  // report finishing.
  async settle(ms: number, since = ms > 0 ? Date.now() - ms - 1000 : undefined): Promise<void> {
    if (ms > 0) await new Promise((r) => setTimeout(r, ms));
    await Promise.all(this.pending);
    // The script that raised the dialog resumes once it is answered. An empty
    // evaluate is queued behind it, so returning means that script finished.
    if (this.active && this.notes.some((n) => n.includes("dialog"))) await this.active.evaluate("0").catch(() => {});
    // A popup the page just opened gets focus emulation before the agent acts on it.
    if (this.active) await this.sessions.get(this.active);
    // Sites that swap pages in place (GitHub, most SPAs) fetch the new content
    // after the click returns. Wait until the page has had no document, script
    // or fetch request open for a moment, but never longer than a few seconds,
    // because polling and analytics requests can keep the page busy forever.
    const inflight = this.active && this.inflight.get(this.active);
    if (since !== undefined && inflight) {
      const busy = () => [...inflight.values()].some((t) => t >= since);
      const deadline = Date.now() + 4000;
      let quietSince = busy() ? 0 : Date.now();
      while (Date.now() < deadline && (!quietSince || Date.now() - quietSince < 250)) {
        await new Promise((r) => setTimeout(r, 50));
        if (busy()) quietSince = 0;
        else quietSince ||= Date.now();
      }
    }
  }

  drainNotes(): string[] {
    return this.notes.splice(0);
  }

  async page(): Promise<Page> {
    if (!this.active || this.active.isClosed()) return this.openWindow();
    await this.sessions.get(this.active);
    return this.active;
  }

  // Page.captureScreenshot waits for a frame that a minimized window never
  // draws. A running screencast makes Chrome draw frames.
  async screenshot(page: Page, fullPage?: boolean): Promise<Buffer> {
    const session = await this.sessions.get(page);
    if (!session) return page.screenshot({ type: "jpeg", quality: 70, fullPage });
    const ack = ({ sessionId }: { sessionId: number }) => void session.send("Page.screencastFrameAck", { sessionId }).catch(() => {});
    session.on("Page.screencastFrame", ack);
    await session.send("Page.startScreencast", { format: "jpeg", maxWidth: 64, maxHeight: 64 });
    try {
      return await page.screenshot({ type: "jpeg", quality: 70, fullPage });
    } finally {
      await session.send("Page.stopScreencast").catch(() => {});
      session.off("Page.screencastFrame", ack);
    }
  }

  // New tabs open from inside the pod's window so they stay in that window.
  // userGesture lets window.open past the popup blocker without disabling it.
  async newTab(url?: string): Promise<Page> {
    const opener = this.active && !this.active.isClosed() ? this.active : undefined;
    if (!opener) {
      const page = await this.openWindow();
      if (url) await page.goto(url);
      return page;
    }
    const session = (await this.sessions.get(opener)) ?? (await this.context.newCDPSession(opener));
    const popup = opener.waitForEvent("popup", { timeout: 10_000 });
    await session.send("Runtime.evaluate", { expression: "window.open('about:blank', '_blank')", userGesture: true });
    const page = this.adopt(await popup);
    this.active = page;
    // The popup listener announced this tab as page-opened; the agent asked for it.
    const own = this.notes.findIndex((n) => n.startsWith("page opened a new tab"));
    if (own >= 0) this.notes.splice(own, 1);
    await this.sessions.get(page);
    if (url) await page.goto(url);
    return page;
  }

  select(index: number): Page {
    const page = this.pages[index];
    if (!page) throw new Error(`No tab ${index} in this pod. Tabs: 0..${this.pages.length - 1}`);
    this.active = page;
    return page;
  }

  activeIndex(): number {
    return this.active ? this.pages.indexOf(this.active) : -1;
  }

  async close(): Promise<void> {
    await Promise.all([...this.pages].map((p) => p.close().catch(() => {})));
    await this.cdp.detach().catch(() => {});
  }
}
