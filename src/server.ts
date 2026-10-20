import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Browser, Frame, Page } from "playwright-core";
import { z } from "zod";
import { Pod, type PodWindow } from "./pod.js";
import { REF_ATTR, readInPage, snapshotInPage } from "./snapshot.js";
import { connectStation } from "./station.js";
import { UNTRUSTED, embeddedDataInPage, outline, pick, redactUrl, redactValue, render } from "./data.js";

const VERSION = "0.1.0";

type Content = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };
const text = (t: string) => ({ content: [{ type: "text", text: t }] as Content[] });

export async function runServer(): Promise<void> {
  const server = new McpServer({ name: "specillum", version: VERSION });
  let browser: Browser | undefined;
  let pod: Pod | undefined;
  const label = process.env.SPECILLUM_POD;
  const windowModes: PodWindow[] = ["visible", "minimized"];
  const mode = (process.env.SPECILLUM_POD_WINDOW ?? "visible") as PodWindow;
  if (!windowModes.includes(mode)) throw new Error(`SPECILLUM_POD_WINDOW must be one of ${windowModes.join(", ")}`);

  // The pod is created lazily so a pod window only appears once the agent
  // actually uses the browser, and it is labelled after the connecting client.
  // If the station was closed, the next call starts it again with a new pod.
  const getPod = async (): Promise<Pod> => {
    if (pod && browser?.isConnected()) return pod;
    browser = await connectStation();
    browser.on("disconnected", () => {
      browser = undefined;
      pod = undefined;
    });
    const client = server.server.getClientVersion()?.name ?? "agent";
    pod = await Pod.launch(browser, label ?? `${client}-${Math.random().toString(36).slice(2, 6)}`, mode);
    return pod;
  };
  const page = async (): Promise<Page> => (await getPod()).page();

  // Frames seen by the last snapshot, so refs like f2e5 resolve to frame 2.
  let snapshotFrames: Frame[] = [];

  const locate = async (ref: string) => {
    const p = await page();
    const m = /^f(\d+)e\d+$/.exec(ref);
    const frame = m ? snapshotFrames[Number(m[1])] : p.mainFrame();
    if (!frame || frame.isDetached() || frame.page() !== p) {
      throw new Error(`Ref ${ref} belongs to a frame that is gone. Call snapshot again.`);
    }
    const loc = frame.locator(`[${REF_ATTR}="${ref}"]`);
    if ((await loc.count()) === 0) throw new Error(`Ref ${ref} not found. The page changed; call snapshot again.`);
    return { p, loc: loc.first() };
  };

  // Snapshots the main frame plus every visible iframe (same- or cross-origin).
  const snapshot = async (p: Page, maxElements = 150) => {
    const main = await p.mainFrame().evaluate(snapshotInPage, { maxElements, refAttr: REF_ATTR, prefix: "e", meta: true });
    const lines = [...main.lines];
    let hidden = main.hidden;
    snapshotFrames = [p.mainFrame()];
    for (const frame of p.frames().slice(1)) {
      const budget = maxElements - lines.length;
      if (budget <= 0) break;
      const box = await frame.frameElement().then((el) => el.boundingBox()).catch(() => null);
      if (!box || box.width < 2 || box.height < 2) continue;
      const index = snapshotFrames.push(frame) - 1;
      const sub = await frame
        .evaluate(snapshotInPage, { maxElements: budget, refAttr: REF_ATTR, prefix: `f${index}e`, meta: false })
        .catch(() => null);
      if (!sub || sub.lines.length === 0) continue;
      lines.push(`-- iframe f${index}: ${frame.url().slice(0, 100)}`, ...sub.lines);
      hidden += sub.hidden;
    }
    const more = hidden > 0 ? `\n(${hidden} more elements not shown; raise maxElements or scroll)` : "";
    return `${main.meta}\nelements:\n${lines.join("\n")}${more}`;
  };

  // Every action reports where the active tab ended up, plus anything that
  // happened on the way (dialogs, new tabs). With snapshot=true it also
  // returns a fresh snapshot so the agent saves a round trip.
  const after = async (note: string, withSnapshot?: boolean, settleMs = 300, since?: number) => {
    const pd = await getPod();
    await pd.settle(settleMs, since);
    const p = await pd.page();
    await p.waitForLoadState("domcontentloaded", { timeout: 5000 }).catch(() => {});
    const events = pd.drainNotes().map((n) => `note: ${n}`);
    const head = [note, ...events].join("\n");
    if (withSnapshot) return text(`${head}\n${await snapshot(p)}`);
    return text(`${head}\nurl: ${p.url()}\ntitle: ${await p.title().catch(() => "")}`);
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
      return text(`pod: ${pd.label} (window: ${pd.mode})\ntabs:\n${await tabList(pd)}`);
    },
  );

  server.registerTool(
    "pod_window",
    {
      description:
        "Show this pod's window to the user or minimize it to the taskbar, e.g. when the user asks to watch, or when you need them to log in or solve a CAPTCHA.",
      inputSchema: { state: z.enum(["show", "minimize"]) },
    },
    async ({ state }) => {
      const pd = await getPod();
      await pd.setWindowState(state === "show" ? "normal" : "minimized");
      return text(state === "show" ? "pod window is shown" : "pod window is minimized");
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
      const t0 = Date.now();
      await p.goto(target, { waitUntil: "domcontentloaded", timeout: 30_000 });
      // Sites keep rendering after DOMContentLoaded and may replace elements,
      // which would drop the refs a snapshot taken now hands out.
      return after("navigated", s, 0, t0);
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
      const t0 = Date.now();
      if (direction === "back") await p.goBack({ timeout: 15_000 });
      else await p.goForward({ timeout: 15_000 });
      return after(direction, s, 0, t0);
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
      return after(`clicked ${ref}`, s);
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
      return after(`typed into ${ref}`, s);
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
      return after(`pressed ${key}`, s);
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
      return after(`selected ${chosen.join(", ")} in ${ref}`, s);
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
      return after(`hovered ${ref}`, s);
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
        return after(`scrolled to ${ref}`, s);
      }
      const p = await page();
      const sign = direction === "up" ? -1 : 1;
      await p.evaluate((dy) => window.scrollBy(0, dy * window.innerHeight), sign * (screens ?? 1));
      return after(`scrolled ${direction ?? "down"}`, s);
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
      return after(needle ? `found "${needle}"` : `waited ${seconds ?? 1}s`, s, 0);
    },
  );

  server.registerTool(
    "dialog",
    {
      description:
        "Decide how to answer the next JavaScript dialog (confirm, prompt, beforeunload) before the action that triggers it. Without this, alerts are accepted and confirms/prompts are dismissed; tool results report every dialog.",
      inputSchema: {
        action: z.enum(["accept", "dismiss"]),
        promptText: z.string().optional().describe("Text to enter when accepting a prompt()."),
      },
    },
    async ({ action, promptText }) => {
      const pd = await getPod();
      pd.nextDialog = { accept: action === "accept", promptText };
      return text(`the next dialog will be ${action === "accept" ? "accepted" : "dismissed"}`);
    },
  );

  server.registerTool(
    "screenshot",
    {
      description: "Take a JPEG screenshot of the active tab. Prefer snapshot for reading; use this for visual checks.",
      inputSchema: { fullPage: z.boolean().optional() },
    },
    async ({ fullPage }) => {
      const pd = await getPod();
      const buf = await pd.screenshot(await pd.page(), fullPage);
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

  const sizeOf = (chars: number) => (chars >= 1000 ? `${(chars / 1000).toFixed(1)}k` : `${chars}`);
  const maxCharsSchema = z.number().int().min(200).max(50_000).optional().describe("Default 8000.");
  const pathSchema = z.string().optional().describe('Part of the JSON to return, e.g. "data.items[0].title".');

  server.registerTool(
    "network",
    {
      description:
        "List the JSON responses (fetch/XHR) this pod's tabs received, newest last. Often the cheapest way to read a site's data: open the page, then read the response that carries it with the response tool. Read-only; headers are never shown.",
      inputSchema: {
        match: z.string().optional().describe("Only responses whose URL contains this text."),
        tab: z.number().int().min(0).optional().describe("Only this tab of the pod."),
        all: z.boolean().optional().describe("Also list non-JSON responses."),
        limit: z.number().int().min(1).max(100).optional().describe("Default 30."),
      },
    },
    async ({ match, tab, all, limit }) => {
      const pd = await getPod();
      const rows = pd.captured
        .filter((c) => all || c.json !== undefined)
        .filter((c) => !match || c.url.includes(match))
        .filter((c) => tab === undefined || pd.pages.indexOf(c.page) === tab)
        .slice(-(limit ?? 30))
        .map((c) => {
          const i = pd.pages.indexOf(c.page);
          const where = i >= 0 ? `tab ${i}` : "closed tab";
          const what = c.json !== undefined ? `${sizeOf(c.chars ?? 0)} chars ${outline(c.json)}` : c.skipped;
          return `[#${c.id}] ${where} ${c.method} ${c.status} ${redactUrl(c.url)} — ${what}`;
        });
      if (!rows.length) return text("No matching JSON responses yet. Open or use the page first; only responses received since the pod opened are listed.");
      return text(`${UNTRUSTED}\n${rows.join("\n")}`);
    },
  );

  server.registerTool(
    "response",
    {
      description:
        "Return the JSON body of one response from the network tool, redacted (secret-looking keys and tokens masked) and size-capped. Use path to take only the part you need.",
      inputSchema: {
        id: z.number().int().min(1).describe("Response id from the network tool, e.g. 12 for [#12]."),
        path: pathSchema,
        maxChars: maxCharsSchema,
      },
    },
    async ({ id, path, maxChars }) => {
      const pd = await getPod();
      const c = pd.captured.find((x) => x.id === id);
      if (!c) throw new Error(`No response #${id}. Call network for current ids; only the latest responses are kept.`);
      if (c.json === undefined) throw new Error(`Response #${id} has no JSON body (${c.skipped}).`);
      const body = render(pick(redactValue(c.json), path), maxChars ?? 8000);
      return text(`#${c.id} ${c.method} ${c.status} ${redactUrl(c.url)}${path ? ` @ ${path}` : ""}\n${UNTRUSTED}\n${body}`);
    },
  );

  server.registerTool(
    "page_data",
    {
      description:
        "Read the structured data the active tab embeds: JSON-LD, framework state such as __NEXT_DATA__, and other JSON script tags. Without index it lists the blocks; with index it returns one, redacted and size-capped.",
      inputSchema: {
        index: z.number().int().min(0).optional().describe("Block to return, from the listing."),
        path: pathSchema,
        maxChars: maxCharsSchema,
      },
    },
    async ({ index, path, maxChars }) => {
      const p = await page();
      const blocks = (await p.evaluate(embeddedDataInPage)).map((b) => {
        try {
          return { kind: b.kind, chars: b.text.length, json: JSON.parse(b.text) as unknown };
        } catch {
          return { kind: b.kind, chars: b.text.length, json: undefined };
        }
      });
      if (!blocks.length) return text("This page embeds no JSON data. Try the network tool or read.");
      if (index === undefined) {
        const rows = blocks.map((b, i) => `[${i}] ${b.kind} — ${sizeOf(b.chars)} chars ${b.json === undefined ? "(invalid JSON)" : outline(b.json)}`);
        return text(`${UNTRUSTED}\n${rows.join("\n")}`);
      }
      const b = blocks[index];
      if (!b) throw new Error(`No block ${index}. Blocks: 0..${blocks.length - 1}`);
      if (b.json === undefined) throw new Error(`Block ${index} (${b.kind}) is not valid JSON.`);
      return text(`[${index}] ${b.kind}${path ? ` @ ${path}` : ""}\n${UNTRUSTED}\n${render(pick(redactValue(b.json), path), maxChars ?? 8000)}`);
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
