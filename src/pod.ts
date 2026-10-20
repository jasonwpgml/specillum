// A pod is one agent's private window inside the station. The pod only ever
// hands out pages it opened itself (or popups those pages opened), so an
// agent cannot see or touch the user's tabs or another agent's pod.
import type { Browser, BrowserContext, Page } from "playwright-core";

async function targetIdOf(context: BrowserContext, page: Page): Promise<string> {
  const session = await context.newCDPSession(page);
  try {
    const { targetInfo } = await session.send("Target.getTargetInfo");
    return targetInfo.targetId;
  } finally {
    await session.detach().catch(() => {});
  }
}

export class Pod {
  readonly pages: Page[] = [];
  private active: Page | undefined;

  private constructor(
    readonly label: string,
    private readonly browser: Browser,
    private readonly context: BrowserContext,
  ) {}

  static async launch(browser: Browser, label: string): Promise<Pod> {
    const context = browser.contexts()[0];
    if (!context) throw new Error("Station has no default browser context.");
    return new Pod(label, browser, context);
  }

  // Opens a fresh window for the pod. Used for the first page and whenever the
  // agent has closed every page it had.
  private async openWindow(): Promise<Page> {
    const cdp = await this.browser.newBrowserCDPSession();
    try {
      const waitForPage = new Promise<Page>((resolve) => {
        const onPage = async (page: Page) => {
          if (!targetId) return;
          if ((await targetIdOf(this.context, page).catch(() => "")) === targetId) {
            this.context.off("page", onPage);
            resolve(page);
          }
        };
        let targetId = "";
        this.context.on("page", onPage);
        cdp.send("Target.createTarget", { url: "about:blank", newWindow: true }).then((r) => {
          targetId = r.targetId;
          // The page event may have fired before targetId was known.
          for (const page of this.context.pages()) void onPage(page);
        });
      });
      return this.adopt(await waitForPage);
    } finally {
      await cdp.detach().catch(() => {});
    }
  }

  private adopt(page: Page): Page {
    if (this.pages.includes(page)) return page;
    this.pages.push(page);
    this.active = page;
    page.on("popup", (popup) => this.adopt(popup));
    page.on("close", () => {
      this.pages.splice(this.pages.indexOf(page), 1);
      if (this.active === page) this.active = this.pages.at(-1);
    });
    return page;
  }

  async page(): Promise<Page> {
    return this.active && !this.active.isClosed() ? this.active : this.openWindow();
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
    const session = await this.context.newCDPSession(opener);
    try {
      const popup = opener.waitForEvent("popup", { timeout: 10_000 });
      await session.send("Runtime.evaluate", { expression: "window.open('about:blank', '_blank')", userGesture: true });
      const page = this.adopt(await popup);
      this.active = page;
      if (url) await page.goto(url);
      return page;
    } finally {
      await session.detach().catch(() => {});
    }
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
  }
}
