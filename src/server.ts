import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Browser, Page } from "playwright-core";
import { z } from "zod";
import { Pod } from "./pod.js";
import { REF_ATTR, readInPage, snapshotInPage } from "./snapshot.js";
import { connectStation } from "./station.js";

const VERSION = "0.1.0";

type Content = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };
const text = (t: string) => ({ content: [{ type: "text", text: t }] as Content[] });

export async function runServer(): Promise<void> {
  const server = new McpServer({ name: "specillum", version: VERSION });
  let browser: Browser | undefined;
  let pod: Pod | undefined;

  // The pod is created lazily so a pod window only appears once the agent
  // actually uses the browser, and it is labelled after the connecting client.
  const getPod = async (): Promise<Pod> => {
    if (pod) return pod;
    browser ??= await connectStation();
    const client = server.server.getClientVersion()?.name ?? "agent";
    const label = process.env.SPECILLUM_POD ?? `${client}-${Math.random().toString(36).slice(2, 6)}`;
    pod = await Pod.launch(browser, label);
    return pod;
  };
  const page = async (): Promise<Page> => (await getPod()).page();

  const locate = async (ref: string) => {
    const p = await page();
    const loc = p.locator(`[${REF_ATTR}="${ref}"]`);
    if ((await loc.count()) === 0) throw new Error(`Ref ${ref} not found. The page changed; call snapshot again.`);
    return { p, loc: loc.first() };
  };

  const snapshot = async (p: Page, maxElements = 150) =>
    p.evaluate(snapshotInPage, { maxElements, refAttr: REF_ATTR });

  // Every action reports where the page ended up; with snapshot=true it also
  // returns a fresh snapshot so the agent saves a round trip.
  const after = async (p: Page, note: string, withSnapshot?: boolean) => {
    await p.waitForLoadState("domcontentloaded", { timeout: 5000 }).catch(() => {});
    if (withSnapshot) return text(`${note}\n${await snapshot(p)}`);
    return text(`${note}\nurl: ${p.url()}\ntitle: ${await p.title().catch(() => "")}`);
  };

  const tabList = async (pd: Pod) => {
    const short = (u: string) => (u.length > 120 ? u.slice(0, 119) + "…" : u);
    const lines = await Promise.all(
      pd.pages.map(async (p, i) => `${i === pd.activeIndex() ? "*" : " "} [${i}] ${await p.title().catch(() => "")} — ${short(p.url())}`),
    );
    return lines.join("\n");
  };

  const snapshotFlag = z.boolean().optional().describe("Return a fresh snapshot after the action.");

  server.registerTool(
    "pod_status",
    {
      description:
        "Show this agent's pod: its label and the tabs it owns. The pod is a private browser window in the shared, logged-in Specillum Chrome. Other agents' pods and the user's own tabs are never visible here.",
      inputSchema: {},
    },
    async () => {
      const pd = await getPod();
      await pd.page();
      return text(`pod: ${pd.label}\ntabs:\n${await tabList(pd)}`);
    },
  );

  server.registerTool(
    "navigate",
    {
      description: "Open a URL in the active tab of this pod.",
      inputSchema: { url: z.string().describe("Absolute URL, or a bare domain like example.com"), snapshot: snapshotFlag },
    },
    async ({ url, snapshot: s }) => {
      const p = await page();
      const target = /^[a-z]+:/i.test(url) ? url : `https://${url}`;
      await p.goto(target, { waitUntil: "domcontentloaded", timeout: 30_000 });
      return after(p, "navigated", s);
    },
  );

  server.registerTool(
    "history",
    {
      description: "Go back or forward in the active tab's history.",
      inputSchema: { direction: z.enum(["back", "forward"]), snapshot: snapshotFlag },
    },
    async ({ direction, snapshot: s }) => {
      const p = await page();
      if (direction === "back") await p.goBack({ timeout: 15_000 });
      else await p.goForward({ timeout: 15_000 });
      return after(p, direction, s);
    },
  );

  server.registerTool(
    "snapshot",
    {
      description:
        "Compact text view of the active tab: title, URL, headings, and visible interactive elements tagged with refs like [e12]. Use the refs with click, type, select and hover. Refs expire when you take a new snapshot.",
      inputSchema: { maxElements: z.number().int().min(10).max(1000).optional().describe("Default 150.") },
    },
    async ({ maxElements }) => text(await snapshot(await page(), maxElements)),
  );

  server.registerTool(
    "read",
    {
      description: "Read the visible text of the page (main content by default) as plain text.",
      inputSchema: {
        selector: z.string().optional().describe("CSS selector to read instead of the main content."),
        maxChars: z.number().int().min(200).max(100_000).optional().describe("Default 8000."),
      },
    },
    async ({ selector, maxChars }) => {
      const p = await page();
      return text(await p.evaluate(readInPage, { selector, maxChars: maxChars ?? 8000 }));
    },
  );

  server.registerTool(
    "click",
    {
      description: "Click an element by its snapshot ref.",
      inputSchema: {
        ref: z.string().describe("Ref from the latest snapshot, e.g. e12"),
        double: z.boolean().optional(),
        button: z.enum(["left", "right", "middle"]).optional(),
        snapshot: snapshotFlag,
      },
    },
    async ({ ref, double, button, snapshot: s }) => {
      const { p, loc } = await locate(ref);
      if (double) await loc.dblclick({ button, timeout: 10_000 });
      else await loc.click({ button, timeout: 10_000 });
      return after(p, `clicked ${ref}`, s);
    },
  );

  server.registerTool(
    "type",
    {
      description: "Type text into an input, textarea or contenteditable element by ref. Replaces existing text unless append is true.",
      inputSchema: {
        ref: z.string(),
        text: z.string(),
        append: z.boolean().optional(),
        submit: z.boolean().optional().describe("Press Enter after typing."),
        snapshot: snapshotFlag,
      },
    },
    async ({ ref, text: value, append, submit, snapshot: s }) => {
      const { p, loc } = await locate(ref);
      if (append) {
        await loc.click({ timeout: 10_000 });
        await p.keyboard.press("End");
        await p.keyboard.insertText(value);
      } else {
        await loc.fill(value, { timeout: 10_000 });
      }
      if (submit) await loc.press("Enter");
      return after(p, `typed into ${ref}`, s);
    },
  );

  server.registerTool(
    "press",
    {
      description: "Press a key or shortcut in the active tab, e.g. Enter, Escape, ArrowDown, Control+A.",
      inputSchema: { key: z.string(), snapshot: snapshotFlag },
    },
    async ({ key, snapshot: s }) => {
      const p = await page();
      await p.keyboard.press(key);
      return after(p, `pressed ${key}`, s);
    },
  );

  server.registerTool(
    "select",
    {
      description: "Choose option(s) in a <select> element by ref, matching option value or label.",
      inputSchema: { ref: z.string(), values: z.array(z.string()).min(1), snapshot: snapshotFlag },
    },
    async ({ ref, values, snapshot: s }) => {
      const { p, loc } = await locate(ref);
      const chosen = await loc.selectOption(values.map((v) => ({ label: v })), { timeout: 3000 }).catch(() => loc.selectOption(values, { timeout: 10_000 }));
      return after(p, `selected ${chosen.join(", ")} in ${ref}`, s);
    },
  );

  server.registerTool(
    "hover",
    {
      description: "Move the mouse over an element by ref (opens hover menus, tooltips).",
      inputSchema: { ref: z.string(), snapshot: snapshotFlag },
    },
    async ({ ref, snapshot: s }) => {
      const { p, loc } = await locate(ref);
      await loc.hover({ timeout: 10_000 });
      return after(p, `hovered ${ref}`, s);
    },
  );

  server.registerTool(
    "scroll",
    {
      description: "Scroll the page by screens, or scroll an element into view by ref.",
      inputSchema: {
        direction: z.enum(["up", "down"]).optional(),
        screens: z.number().min(0.1).max(20).optional().describe("Default 1."),
        ref: z.string().optional().describe("Scroll this element into view instead."),
        snapshot: snapshotFlag,
      },
    },
    async ({ direction, screens, ref, snapshot: s }) => {
      if (ref) {
        const { p, loc } = await locate(ref);
        await loc.scrollIntoViewIfNeeded({ timeout: 10_000 });
        return after(p, `scrolled to ${ref}`, s);
      }
      const p = await page();
      const sign = direction === "up" ? -1 : 1;
      await p.evaluate((dy) => window.scrollBy(0, dy * window.innerHeight), sign * (screens ?? 1));
      return after(p, `scrolled ${direction ?? "down"}`, s);
    },
  );

  server.registerTool(
    "wait",
    {
      description: "Wait for text to appear on the page, or for a fixed time.",
      inputSchema: {
        text: z.string().optional(),
        seconds: z.number().min(0).max(60).optional().describe("Fixed wait, or the timeout when text is given (default 10)."),
        snapshot: snapshotFlag,
      },
    },
    async ({ text: needle, seconds, snapshot: s }) => {
      const p = await page();
      if (needle) await p.getByText(needle).first().waitFor({ timeout: (seconds ?? 10) * 1000 });
      else await p.waitForTimeout((seconds ?? 1) * 1000);
      return after(p, needle ? `found "${needle}"` : `waited ${seconds ?? 1}s`, s);
    },
  );

  server.registerTool(
    "screenshot",
    {
      description: "Take a JPEG screenshot of the active tab. Prefer snapshot for reading; use this for visual checks.",
      inputSchema: { fullPage: z.boolean().optional() },
    },
    async ({ fullPage }) => {
      const p = await page();
      const buf = await p.screenshot({ type: "jpeg", quality: 70, fullPage });
      return { content: [{ type: "image", data: buf.toString("base64"), mimeType: "image/jpeg" }] as Content[] };
    },
  );

  server.registerTool(
    "tabs",
    {
      description: "Manage the tabs of this pod only: list, open a new tab (optionally at a URL), switch to a tab, or close one.",
      inputSchema: {
        action: z.enum(["list", "new", "select", "close"]),
        index: z.number().int().min(0).optional().describe("Tab index for select/close (close defaults to the active tab)."),
        url: z.string().optional().describe("URL for a new tab."),
      },
    },
    async ({ action, index, url }) => {
      const pd = await getPod();
      if (action === "new") await pd.newTab(url && (/^[a-z]+:/i.test(url) ? url : `https://${url}`));
      if (action === "select") {
        const p = pd.select(index ?? 0);
        await p.bringToFront();
      }
      if (action === "close") {
        const p = index === undefined ? await pd.page() : pd.select(index);
        await p.close();
      }
      if (pd.pages.length === 0) await pd.page();
      return text(await tabList(pd));
    },
  );

  server.registerTool(
    "evaluate",
    {
      description: "Run a JavaScript expression in the active tab and return the JSON result. For reading data the other tools do not expose.",
      inputSchema: { expression: z.string().describe("Expression or async IIFE, e.g. document.querySelectorAll('li').length") },
    },
    async ({ expression }) => {
      const p = await page();
      const result = await p.evaluate(`(async () => (${expression}))()`);
      return text(JSON.stringify(result, null, 2) ?? "undefined");
    },
  );

  // Close the pod window when the agent disconnects, unless asked to keep it.
  const shutdown = async () => {
    if (pod && process.env.SPECILLUM_KEEP_POD !== "1") await pod.close();
    process.exit(0);
  };
  process.stdin.on("close", shutdown);
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await server.connect(new StdioServerTransport());
}
