// Fake answers to a pod's requests, to test how a page handles a failure or an
// empty list. Navigations always go to the real site: a mock cannot forge a
// logged-in page or get a tab past the allowlist.
import type { Page, Request, Route } from "playwright-core";

export type Mock = { match: string; status: number; body: string; contentType: string; abort: boolean };

export class MockList {
  readonly entries: Mock[] = [];
  private readonly attached = new WeakSet<Page>();

  // The newest mock wins, so an agent can override an earlier one.
  private readonly handler = (route: Route, req: Request) => {
    const mock = req.isNavigationRequest() ? undefined : [...this.entries].reverse().find((m) => req.url().includes(m.match));
    if (!mock) return route.fallback();
    if (mock.abort) return route.abort("failed");
    return route.fulfill({ status: mock.status, body: mock.body, contentType: mock.contentType });
  };

  // The route costs the tab its HTTP cache, so it is only there while a mock is.
  async attach(page: Page): Promise<void> {
    if (!this.entries.length || this.attached.has(page)) return;
    this.attached.add(page);
    await page.route("**/*", this.handler);
  }

  async add(mock: Mock, pages: Page[]): Promise<void> {
    this.entries.push(mock);
    await Promise.all(pages.map((p) => this.attach(p)));
  }

  async clear(pages: Page[]): Promise<void> {
    this.entries.length = 0;
    await Promise.all(
      pages.map(async (p) => {
        this.attached.delete(p);
        await p.unroute("**/*", this.handler).catch(() => {});
      }),
    );
  }
}
