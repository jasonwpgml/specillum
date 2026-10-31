// Window modes and the user's own tabs: a minimized pod works like a visible
// one, and a pod never answers dialogs in tabs it does not own.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";

const port = "9777";
const profile = mkdtempSync(join(tmpdir(), "specillum-modes-"));
const base = { ...process.env, SPECILLUM_PORT: port, SPECILLUM_PROFILE: profile };

async function agent(name, mode) {
  const client = new Client({ name, version: "0.0.0" });
  await client.connect(
    new StdioClientTransport({ command: "node", args: ["dist/cli.js"], env: { ...base, SPECILLUM_POD_WINDOW: mode } }),
  );
  const call = async (tool, args = {}) => {
    const res = await client.callTool({ name: tool, arguments: args });
    const out = res.content.map((c) => c.text ?? `[${c.type}:${c.data?.length ?? 0}]`).join("\n");
    if (res.isError) throw new Error(`${tool}: ${out}`);
    return out;
  };
  return { client, call };
}

let failed = 0;
async function check(name, fn) {
  try {
    const d = await fn();
    console.log(`PASS ${name}${d ? " — " + d : ""}`);
  } catch (e) {
    failed++;
    console.log(`FAIL ${name} — ${String(e.message ?? e).slice(0, 800)}`);
  }
}
const expect = (c, m) => {
  if (!c) throw new Error(m);
};

const mini = await agent("mini-agent", "minimized");
let observer;

const windowOf = async (cdp, titlePart) => {
  const { targetInfos } = await cdp.send("Target.getTargets");
  const t = targetInfos.find((t) => t.type === "page" && t.title.includes(titlePart));
  if (!t) return { found: false };
  try {
    const { windowId, bounds } = await cdp.send("Browser.getWindowForTarget", { targetId: t.targetId });
    return { found: true, windowId, state: bounds.windowState };
  } catch (e) {
    return { found: true, noWindow: String(e.message) };
  }
};

try {
  await check("minimized pod: browse, type, screenshot on a real site", async () => {
    const s = await mini.call("navigate", { url: "https://en.wikipedia.org/wiki/Main_Page", snapshot: true });
    const box = s.match(/\[(e\d+)\] [^\n]*Search Wikipedia/)?.[1];
    expect(box, "no search box (viewport too small?)");
    const r = await mini.call("type", { ref: box, text: "Chromium", submit: true });
    expect(/Chromium/.test(r), "search failed:\n" + r);
    const shot = await mini.call("screenshot");
    expect(/\[image:\d{4,}\]/.test(shot), "no screenshot");
    const vis = await mini.call("evaluate", { expression: "[document.visibilityState, innerWidth, innerHeight]" });
    return `visibility/viewport ${vis.replace(/\s+/g, "")}`;
  });

  await check("minimized pod: popup from a link works too", async () => {
    const opener = await mini.call("navigate", { url: "data:text/html,<title>opener</title><a href='https://example.com/' target=_blank>open</a>", snapshot: true });
    const r = await mini.call("click", { ref: opener.match(/\[(e\d+)\] link "open"/)?.[1] });
    expect(/new tab/.test(r), "popup not reported:\n" + r);
    const s = await mini.call("snapshot");
    const link = s.match(/\[(e\d+)\] link [^\n]*-> [^\n]*iana/)?.[1];
    expect(link, "no link in popup:\n" + s);
    const c = await mini.call("click", { ref: link });
    expect(/url: https:\/\/www\.iana\.org/.test(c), "click in popup did not navigate:\n" + c);
    await mini.call("tabs", { action: "close" });
  });

  observer = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { noDefaults: true });
  const cdp = await observer.newBrowserCDPSession();

  await check("minimized pod: window starts minimized and still works", async () => {
    const r = await mini.call("navigate", { url: "data:text/html,<title>mini-page</title><button onclick=\"document.title='mini-clicked'\">Go</button>", snapshot: true });
    const btn = r.match(/\[(e\d+)\] button "Go"/)?.[1];
    expect(btn, "no button:\n" + r);
    const c = await mini.call("click", { ref: btn });
    expect(c.includes("mini-clicked"), "click failed in minimized window:\n" + c);
    const shot = await mini.call("screenshot");
    expect(/\[image:\d{3,}\]/.test(shot), "no screenshot from minimized window");
    const w = await windowOf(cdp, "mini-clicked");
    expect(w.state === "minimized", "window state is " + JSON.stringify(w));
  });

  await check("pod_window show / minimize", async () => {
    await mini.call("pod_window", { state: "show" });
    let w = await windowOf(cdp, "mini-clicked");
    expect(w.state === "normal", "after show: " + JSON.stringify(w));
    await mini.call("pod_window", { state: "minimize" });
    w = await windowOf(cdp, "mini-clicked");
    expect(w.state === "minimized", "after minimize: " + JSON.stringify(w));
  });

  await check("dialogs in the user's own tab are left for the user", async () => {
    const ctx = observer.contexts()[0];
    const userTab = await ctx.newPage();
    let dialog;
    userTab.on("dialog", (d) => (dialog = d)); // look, don't answer
    await userTab.goto("data:text/html,<title>user-tab</title>");
    await userTab.evaluate(() => setTimeout(() => alert("user dialog"), 0));
    await new Promise((r) => setTimeout(r, 1500)); // pods' connections had time to interfere
    expect(dialog, "observer never saw the dialog");
    // accept() fails if a pod connection already dismissed it.
    await dialog.accept();
    await userTab.close();
  });
} finally {
  await mini.client.close().catch(() => {});
  try {
    const b = observer ?? (await chromium.connectOverCDP(`http://127.0.0.1:${port}`));
    await (await b.newBrowserCDPSession()).send("Browser.close");
  } catch {}
  await new Promise((r) => setTimeout(r, 1500));
  rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  console.log(failed ? `\n${failed} failed` : "\nALL PASSED");
  process.exitCode = failed ? 1 : 0;
}
