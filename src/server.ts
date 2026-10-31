import { realpathSync, statSync } from "node:fs";
import { basename, delimiter, isAbsolute, relative, resolve, sep } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Browser, Frame, Locator, Page } from "playwright-core";
import { z } from "zod";
import { Pod, assertAllowed, type PodWindow } from "./pod.js";
import { REF_ATTR, annotateInPage, blockerInPage, readInPage, snapshotInPage, type SnapshotItem } from "./snapshot.js";
import { connectStation, headless } from "./station.js";
import { UNTRUSTED, embeddedDataInPage, outline, pick, redactString, redactUrl, redactValue, render } from "./data.js";
import { deleteRecipe, fillStep, listRecipes, loadRecipe, onSite, saveRecipe, stepSchema, validateRecipe, type Recipe, type Step } from "./recipes.js";

const VERSION = "0.1.0";

type Content = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };
const text = (t: string) => ({ content: [{ type: "text", text: t }] as Content[] });

// localhost:3000 looks like a URL with the scheme "localhost", and a local server
// rarely speaks https.
function toUrl(input: string): string {
  if (/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?([/?#]|$)/i.test(input)) return `http://${input}`;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(input) || /^(about|data|blob|javascript):/i.test(input)) return input;
  return `https://${input}`;
}

// A web page could ask for any file the agent can name, so uploads only come
// from the directory the agent runs in and any the user added. Links are
// resolved first, so one cannot point out of those directories.
function uploadFile(path: string): string {
  const roots = [process.cwd(), ...(process.env.SPECILLUM_UPLOAD_DIRS?.split(delimiter).filter(Boolean) ?? [])];
  let real: string;
  try {
    real = realpathSync(resolve(path));
  } catch {
    throw new Error(`No such file: ${path}`);
  }
  const inside = roots.some((root) => {
    const rel = relative(realpathSync(root), real);
    return rel && !rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel);
  });
  if (!inside) throw new Error(`${path} is outside the directories uploads may come from: ${roots.join(", ")}. The user can add one with SPECILLUM_UPLOAD_DIRS.`);
  if (!statSync(real).isFile()) throw new Error(`Not a file: ${path}`);
  return real;
}

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

  // Every frame a snapshot has numbered, so refs like f2e5 resolve to frame 2. A
  // frame keeps its number, which keeps the refs inside it stable. 0 is unused.
  const snapshotFrames: (Frame | undefined)[] = [undefined];
  let snapshotItems: SnapshotItem[] = [];

  const locate = async (ref: string) => {
    const p = await page();
    const m = /^f(\d+)e\d+$/.exec(ref);
    const index = m ? Number(m[1]) : 0;
    const frame = m ? snapshotFrames[index] : p.mainFrame();
    if (!frame || frame.isDetached() || frame.page() !== p) {
      if (frame?.isDetached()) snapshotFrames[index] = undefined;
      throw new Error(`Ref ${ref} belongs to a frame that is gone. Call snapshot again.`);
    }
    const loc = frame.locator(`[${REF_ATTR}="${ref}"]`);
    if ((await loc.count()) === 0) throw new Error(`Ref ${ref} not found. The page changed; call snapshot again.`);
    return { p, loc: loc.first() };
  };

  // Snapshots the main frame plus every visible iframe (same- or cross-origin).
  const lastRefs = new WeakMap<Frame, number>();
  const readFrame = async (frame: Frame, maxElements: number, prefix: string, meta: boolean) => {
    const s = await frame.evaluate(snapshotInPage, { maxElements, refAttr: REF_ATTR, prefix, meta, firstRef: lastRefs.get(frame) ?? 0 });
    lastRefs.set(frame, s.lastRef);
    return s;
  };

  const readPage = async (p: Page, maxElements: number) => {
    const main = await readFrame(p.mainFrame(), maxElements, "e", true);
    const lines = [...main.lines];
    let hidden = main.hidden;
    snapshotItems = [...main.items];
    // Ad-heavy pages carry dozens of iframes, and a frame that is navigating never
    // answers, so they are read together and a slow one is left out. A main frame
    // that used up the limit leaves no room for them, so they are not read at all.
    const frames = lines.length < maxElements ? p.frames().slice(1) : [];
    const subs = await Promise.all(frames.map(async (frame) => {
      const box = await frame.frameElement().then((el) => el.boundingBox()).catch(() => null);
      if (!box || box.width < 2 || box.height < 2) return null;
      const known = snapshotFrames.indexOf(frame);
      const index = known > 0 ? known : snapshotFrames.push(frame) - 1;
      const sub = await Promise.race([
        readFrame(frame, maxElements, `f${index}e`, false).catch(() => null),
        new Promise<null>((r) => setTimeout(r, 2000, null)),
      ]);
      return sub && { index, frame, sub };
    }));
    for (const found of subs) {
      if (!found || found.sub.lines.length === 0) continue;
      const { index, frame, sub } = found;
      const budget = maxElements - lines.length;
      hidden += sub.hidden + Math.max(0, sub.lines.length - Math.max(0, budget));
      if (budget <= 0) continue;
      lines.push(`-- iframe f${index}: ${frame.url().slice(0, 100)}`, ...sub.lines.slice(0, budget));
      snapshotItems.push(...sub.items.slice(0, budget));
    }
    return { meta: main.meta, doc: main.doc, lines, hidden };
  };

  const fullView = (s: Awaited<ReturnType<typeof readPage>>, lines = s.lines) => {
    const more = s.hidden > 0 ? `\n(${s.hidden} more elements not shown; raise maxElements or scroll)` : "";
    return `${UNTRUSTED}\n${s.meta}\nelements:\n${lines.join("\n")}${more}`;
  };

  const snapshot = async (p: Page, maxElements = 150) => fullView(await readPage(p, maxElements));

  // What the agent last saw of each tab, to answer "what changed?". Snapshots a
  // recipe takes for itself do not count, since the agent never saw them.
  const seen = new WeakMap<Page, { doc: string; maxElements: number; meta: string; lines: Map<string, string> }>();
  const REF_LINE = /^\[(\S+?)\]/;

  const view = async (p: Page, opts: { maxElements?: number; match?: string; changes?: boolean } = {}) => {
    if (opts.match) {
      const s = await readPage(p, opts.maxElements ?? 1000);
      const needle = opts.match.toLowerCase();
      const hits = s.lines.filter((l) => REF_LINE.test(l) && l.toLowerCase().includes(needle));
      return `${fullView(s, hits)}\n(${hits.length} elements match "${opts.match}")`;
    }
    const maxElements = opts.maxElements ?? 150;
    const s = await readPage(p, maxElements);
    const lines = new Map(s.lines.flatMap((l): [string, string][] => {
      const ref = REF_LINE.exec(l)?.[1];
      return ref ? [[ref, l]] : [];
    }));
    const before = seen.get(p);
    seen.set(p, { doc: s.doc, maxElements, meta: s.meta, lines });
    const full = fullView(s);
    if (!opts.changes || !before || before.doc !== s.doc || before.maxElements !== maxElements) return full;
    const diff = [
      ...[...lines].filter(([ref]) => !before.lines.has(ref)).map(([, l]) => `+ ${l}`),
      ...[...lines].filter(([ref, l]) => before.lines.has(ref) && before.lines.get(ref) !== l).map(([, l]) => `~ ${l}`),
      ...[...before.lines].filter(([ref]) => !lines.has(ref)).map(([, l]) => `- ${l}`),
    ];
    if (!diff.length && before.meta === s.meta) return "unchanged since the last snapshot";
    const delta = `${UNTRUSTED}\n${s.meta}\nchanges since the last snapshot (+ new, ~ changed, - gone or past the element limit):\n${diff.join("\n") || "none in the elements"}`;
    return delta.length < full.length ? delta : full;
  };

  // Every action reports where the active tab ended up, plus anything that
  // happened on the way (dialogs, new tabs). With snapshot=true it also
  // returns a fresh snapshot so the agent saves a round trip.
  const after = async (note: string, withSnapshot?: boolean | "changes", settleMs = 100, since?: number) => {
    const pd = await getPod();
    await pd.settle(settleMs, since);
    const p = await pd.page();
    await p.waitForLoadState("domcontentloaded", { timeout: 5000 }).catch(() => {});
    const events = pd.drainNotes().map((n) => `note: ${n}`);
    const head = [note, ...events].join("\n");
    if (withSnapshot) return text(`${head}\n${await view(p, { changes: withSnapshot === "changes" })}`);
    return text(`${head}\nurl: ${p.url()}\ntitle: ${await p.title().catch(() => "")}`);
  };

  const tabList = async (pd: Pod) => {
    const short = (u: string) => (u.length > 120 ? u.slice(0, 119) + "…" : u);
    const lines = await Promise.all(
      pd.pages.map(async (p, i) => `${i === pd.activeIndex() ? "*" : " "} [${i}] ${await p.title().catch(() => "")} — ${short(p.url())}`),
    );
    return lines.join("\n");
  };

  const snapshotFlag = z.union([z.boolean(), z.literal("changes")]).optional().describe('Also return a snapshot, or "changes" for only what changed.');

  // Waiting out the full timeout behind a cookie banner tells the agent nothing,
  // so a click that cannot land soon says what is in the way. The trial never
  // clicks, so nothing is pressed twice.
  const clickOn = async (loc: Locator, what: string, options: { button?: "left" | "right" | "middle"; double?: boolean } = {}) => {
    const { double, button } = options;
    await loc.click({ trial: true, button, timeout: 4000 }).catch(async () => {
      await loc.scrollIntoViewIfNeeded({ timeout: 1000 }).catch(() => {});
      const blocker = await loc.evaluate(blockerInPage).catch(() => null);
      if (blocker) throw new Error(`Cannot click ${what}: it is covered by ${blocker}. Deal with that first, then click again.`);
    });
    if (double) await loc.dblclick({ button, timeout: 10_000 });
    else await loc.click({ button, timeout: 10_000 });
  };

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
      if (state === "show" && headless()) throw new Error("SPECILLUM_HEADLESS is set, so there is no window to show. The user can log in with `specillum open` after closing the station.");
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
      const target = toUrl(url);
      assertAllowed(target);
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
        "Compact text view of the active tab: title, URL, headings, and visible interactive elements tagged with refs like [e12]. Use the refs with click, type, select and hover. An element keeps its ref until it leaves the page or the page reloads.",
      inputSchema: {
        maxElements: z.number().int().min(10).max(1000).optional().describe("Default 150."),
        match: z.string().optional().describe("Only elements whose line contains this text, searching up to 1000 elements. Finds one control on a long page cheaply."),
        changes: z.boolean().optional().describe("Only what changed since your last snapshot of this tab. Falls back to a full snapshot after a navigation. Not with match."),
      },
    },
    async ({ maxElements, match, changes }) => {
      if (match && changes) throw new Error("Use match or changes, not both.");
      return text(await view(await page(), { maxElements, match, changes }));
    },
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
      return text(`${UNTRUSTED}\n${await p.evaluate(readInPage, { selector, maxChars: maxChars ?? 8000 })}`);
    },
  );

  server.registerTool(
    "click",
    {
      description: "Click an element by its snapshot ref. If something covers it, the error names what, such as a cookie banner.",
      inputSchema: {
        ref: z.string().describe("Ref from the latest snapshot, e.g. e12"),
        double: z.boolean().optional(),
        button: z.enum(["left", "right", "middle"]).optional(),
        snapshot: snapshotFlag,
      },
    },
    async ({ ref, double, button, snapshot: s }) => {
      const { loc } = await locate(ref);
      await clickOn(loc, ref, { double, button });
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
    "drag",
    {
      description: "Drag one element onto another by ref, e.g. a card between columns.",
      inputSchema: { from: z.string(), to: z.string(), snapshot: snapshotFlag },
    },
    async ({ from, to, snapshot: s }) => {
      const source = await locate(from);
      const target = await locate(to);
      await source.loc.dragTo(target.loc, { timeout: 10_000 });
      return after(`dragged ${from} onto ${to}`, s);
    },
  );

  server.registerTool(
    "upload",
    {
      description:
        "Attach local files to a file input. Give the ref of the input or of the button that opens the file picker; without a ref, the page's only file input is used, even a hidden one. Files must be inside the directory the agent runs in or one the user added.",
      inputSchema: {
        paths: z.array(z.string()).min(1).describe("File paths."),
        ref: z.string().optional(),
        snapshot: snapshotFlag,
      },
    },
    async ({ paths, ref, snapshot: s }) => {
      const files = paths.map(uploadFile);
      const names = files.map((f) => basename(f)).join(", ");
      if (ref) {
        const { p, loc } = await locate(ref);
        const isInput = await loc.evaluate((el) => el instanceof HTMLInputElement && el.type === "file");
        if (isInput) await loc.setInputFiles(files, { timeout: 10_000 });
        else {
          const chooser = p.waitForEvent("filechooser", { timeout: 5000 });
          await clickOn(loc, ref);
          const opened = await chooser.catch(() => {
            throw new Error(`Clicking ${ref} did not open a file picker.`);
          });
          await opened.setFiles(files, { timeout: 10_000 });
        }
        return after(`uploaded ${names} through ${ref}`, s);
      }
      const inputs: Locator[] = [];
      for (const frame of (await page()).frames()) {
        const found = frame.locator("input[type=file]");
        for (let i = 0; i < (await found.count().catch(() => 0)); i++) inputs.push(found.nth(i));
      }
      if (inputs.length !== 1) throw new Error(`This page has ${inputs.length} file inputs. Give the ref of the input or of the button that opens the file picker.`);
      await inputs[0]!.setInputFiles(files, { timeout: 10_000 });
      return after(`uploaded ${names}`, s);
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
      description:
        "Wait for text to appear or go away, for the URL to change, or for a fixed time. After asking the user to log in through pod_window, wait for the URL they will land on.",
      inputSchema: {
        text: z.string().optional(),
        gone: z.string().optional().describe("Wait until this text is no longer visible, e.g. a loading message."),
        url: z.string().optional().describe("Wait until the tab's URL contains this."),
        seconds: z.number().min(0).max(300).optional().describe("Fixed wait, or the timeout when waiting for something (default 10)."),
        snapshot: snapshotFlag,
      },
    },
    async ({ text: needle, gone, url, seconds, snapshot: s }) => {
      const p = await page();
      const timeout = (seconds ?? 10) * 1000;
      if (needle) await p.getByText(needle).first().waitFor({ timeout });
      if (gone) await p.getByText(gone).first().waitFor({ state: "hidden", timeout });
      if (url) await p.waitForURL((u) => u.href.includes(url), { timeout, waitUntil: "commit" });
      const waited = [needle && `found "${needle}"`, gone && `"${gone}" is gone`, url && `url contains "${url}"`].filter(Boolean).join(", ");
      if (!waited) await p.waitForTimeout((seconds ?? 1) * 1000);
      return after(waited || `waited ${seconds ?? 1}s`, s, 0);
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
      inputSchema: {
        fullPage: z.boolean().optional(),
        annotate: z.boolean().optional().describe("Label each element with its ref, so what you see can be clicked by ref."),
      },
    },
    async ({ fullPage, annotate }) => {
      const pd = await getPod();
      const p = await pd.page();
      const label = (on: boolean) => Promise.all(p.frames().map((f) => f.evaluate(annotateInPage, { refAttr: REF_ATTR, on }).catch(() => {})));
      if (annotate) {
        await snapshot(p, 1000);
        await label(true);
      }
      try {
        const buf = await pd.screenshot(p, fullPage);
        return { content: [{ type: "image", data: buf.toString("base64"), mimeType: "image/jpeg" }] as Content[] };
      } finally {
        if (annotate) await label(false);
      }
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
      if (action === "new") {
        const target = url && toUrl(url);
        if (target) assertAllowed(target);
        await pd.newTab(target);
      }
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
    "console",
    {
      description: "Read what this pod's tabs logged to the browser console, plus uncaught errors, newest last. Use it when a page misbehaves.",
      inputSchema: {
        errors: z.boolean().optional().describe("Only errors."),
        match: z.string().optional().describe("Only messages containing this text."),
        tab: z.number().int().min(0).optional().describe("Only this tab of the pod."),
        limit: z.number().int().min(1).max(200).optional().describe("Default 30."),
      },
    },
    async ({ errors, match, tab, limit }) => {
      const pd = await getPod();
      const rows = pd.logs
        .filter((l) => !errors || l.level === "error")
        .filter((l) => !match || l.text.includes(match))
        .filter((l) => tab === undefined || pd.pages.indexOf(l.page) === tab)
        .slice(-(limit ?? 30))
        .map((l) => {
          const i = pd.pages.indexOf(l.page);
          return `${i >= 0 ? `tab ${i}` : "closed tab"} ${l.level}: ${redactString(l.text)}`;
        });
      if (!rows.length) return text("No matching console messages. Only messages since the tab joined this pod are kept.");
      return text(`${UNTRUSTED}\n${rows.join("\n")}`);
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

  // Finds a recipe step's element by what the snapshot shows, in any frame,
  // waiting for it to render. Several matches fail rather than guess.
  const findElement = async (p: Page, t: { role: string; name: string; contains?: boolean; nth?: number }) => {
    const wanted = `${t.role} "${t.name}"`;
    const deadline = Date.now() + 10_000;
    while (true) {
      // A navigation can destroy the page's context while it is being read.
      const read = await readPage(p, 1000).then(() => true, () => false);
      const hits = read ? snapshotItems.filter((i) => i.role === t.role && (t.contains ? i.name.includes(t.name) : i.name === t.name)) : [];
      if (hits.length > 1 && t.nth === undefined) {
        throw new Error(`${hits.length} elements match ${wanted}: ${hits.slice(0, 5).map((h) => `"${h.name}"`).join(", ")}. Set nth or a more exact name.`);
      }
      const hit = hits[t.nth ?? 0];
      if (hit) return (await locate(hit.ref)).loc;
      if (Date.now() > deadline) throw new Error(`No element matches ${wanted}.`);
      await p.waitForTimeout(300);
    }
  };

  const waitForText = async (p: Page, needle: string, seconds: number) => {
    const deadline = Date.now() + seconds * 1000;
    while (true) {
      for (const frame of p.frames()) {
        if (await frame.getByText(needle).first().isVisible().catch(() => false)) return;
      }
      if (Date.now() > deadline) throw new Error(`Expected text did not appear within ${seconds}s: "${needle}".`);
      await p.waitForTimeout(300);
    }
  };

  const viewportOf = (p: Page) => p.evaluate(() => ({ width: innerWidth, height: innerHeight }));

  // Right after a navigation Chrome can drop a raw mouse press while still
  // delivering moves. A press the page never saw did nothing, so it is safe to
  // repeat. Locator clicks wait for this on their own; a bare mouse click does
  // not. An iframe's presses never report here, so those get one attempt and
  // the recipe's expect step catches a miss.
  const clickAt = async (p: Page, x: number, y: number) => {
    const FLAG = "__specillumPressed";
    const overFrame = await p.evaluate(([px, py]) => document.elementFromPoint(px!, py!)?.tagName === "IFRAME", [x, y]);
    for (let i = 0; i < 10; i++) {
      await p.evaluate((flag) => {
        const w = window as unknown as Record<string, boolean>;
        w[flag] = false;
        addEventListener("mousedown", () => (w[flag] = true), { once: true, capture: true });
      }, FLAG);
      await p.mouse.click(x, y);
      // A click that navigates destroys the page it would be read from.
      const pressed = await p.evaluate((flag) => (window as unknown as Record<string, boolean>)[flag], FLAG).catch(() => true);
      if (overFrame || pressed) return;
      await p.waitForTimeout(300);
    }
    throw new Error(`The page never received the click at ${x},${y}.`);
  };

  const runStep = async (pd: Pod, recipe: Recipe, step: Step) => {
    const p = await pd.page();
    const t0 = Date.now();
    if (step.do === "goto") {
      if (!onSite(step.url, recipe.site)) throw new Error(`goto leaves the recipe's site ${recipe.site}: ${redactUrl(step.url)}`);
      await p.goto(step.url, { waitUntil: "domcontentloaded", timeout: 30_000 });
      await pd.settle(0, t0);
      return;
    }
    // A redirect may have landed on another site, or a login page elsewhere.
    if (!onSite(p.url(), recipe.site)) throw new Error(`The tab is not on the recipe's site ${recipe.site}.`);
    switch (step.do) {
      case "click":
        await clickOn(await findElement(p, step), `${step.role} "${step.name}"`);
        break;
      case "type": {
        const loc = await findElement(p, step);
        if ((await loc.getAttribute("type")) === "password") throw new Error("Recipes never type into password fields; ask the user to log in.");
        await loc.fill(step.text, { timeout: 10_000 });
        if (step.submit) await loc.press("Enter");
        break;
      }
      case "press":
        await p.keyboard.press(step.key);
        break;
      case "expect":
        await waitForText(p, step.text, step.seconds ?? 10);
        return;
      case "click_at": {
        const now = await viewportOf(p);
        const saved = recipe.viewport;
        if (!saved || saved.width !== now.width || saved.height !== now.height) {
          throw new Error(`click_at was saved for a ${saved?.width}x${saved?.height} viewport; this tab is ${now.width}x${now.height}. Save the recipe again at this size.`);
        }
        await clickAt(p, step.x, step.y);
        break;
      }
    }
    await pd.settle(100);
  };

  const describeRecipe = (r: Recipe) => {
    const params = r.params.length ? ` (${r.params.join(", ")})` : "";
    return `${r.name}${params} on ${r.site}, ${r.steps.length} steps${r.description ? ` — ${r.description}` : ""}`;
  };

  server.registerTool(
    "recipe",
    {
      description:
        "Save and replay a series of steps for one site, so a repeated task does not need the page read again. Before doing a task by hand, list recipes for the site. After finishing a task you will repeat, save it, using the role and name the snapshot printed, with {param} placeholders for what changes, and end with an expect step. If a run fails, it stops at that step and returns a snapshot: fix the steps and save again under the same name. Never put passwords or other secrets in steps.",
      inputSchema: {
        action: z.enum(["list", "show", "save", "run", "delete"]),
        name: z.string().optional().describe("Recipe name: lowercase letters, digits, - and _. Required except for list."),
        site: z.string().optional().describe("save: host the recipe may act on, including its subdomains, e.g. naver.com. list: only recipes for this host."),
        description: z.string().optional().describe("save: what the recipe does."),
        params: z.array(z.string()).optional().describe("save: names of the {placeholders} the steps use."),
        steps: z.array(stepSchema).optional().describe("save: the steps, in order."),
        values: z.record(z.string(), z.string()).optional().describe("run: a value for every parameter."),
        snapshot: snapshotFlag,
      },
    },
    async ({ action, name, site, description, params, steps, values, snapshot: s }) => {
      if (action === "list") {
        const all = listRecipes().filter((r) => !site || r.site === site || site.endsWith(`.${r.site}`));
        return text(all.length ? all.map(describeRecipe).join("\n") : "No recipes saved yet.");
      }
      if (!name) throw new Error(`recipe ${action} needs a name.`);
      if (action === "show") return text(JSON.stringify(loadRecipe(name), null, 2));
      if (action === "delete") {
        deleteRecipe(name);
        return text(`deleted recipe ${name}`);
      }
      if (action === "save") {
        if (!site || !steps) throw new Error("recipe save needs site and steps.");
        const recipe: Recipe = { name, site, description, params: params ?? [], steps };
        validateRecipe(recipe);
        if (steps.some((step) => step.do === "click_at")) recipe.viewport = await viewportOf(await page());
        saveRecipe(recipe);
        return text(`saved recipe ${describeRecipe(recipe)}`);
      }

      const recipe = loadRecipe(name);
      const missing = recipe.params.filter((p) => values?.[p] === undefined);
      if (missing.length) throw new Error(`recipe ${name} needs values for: ${missing.join(", ")}`);
      const pd = await getPod();
      for (const [i, step] of recipe.steps.entries()) {
        try {
          await runStep(pd, recipe, fillStep(step, values ?? {}));
        } catch (err) {
          const p = await pd.page();
          const state = await snapshot(p).catch(() => `url: ${p.url()}`);
          // The saved step, not the filled one, so values stay out of the report.
          throw new Error(
            `recipe ${name} stopped at step ${i + 1}/${recipe.steps.length}: ${JSON.stringify(step)}\nreason: ${(err as Error).message}\nThe page is left as it is:\n${state}`,
          );
        }
      }
      return after(`ran recipe ${name}: ${recipe.steps.length} steps`, s, 0);
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
