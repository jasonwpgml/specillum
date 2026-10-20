// Live check against real websites (needs internet). Every case runs even if
// an earlier one fails, so one run shows everything that is broken.
// Uses a throwaway profile and port, never your real station.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";

const port = "9555";
const profile = mkdtempSync(join(tmpdir(), "specillum-live-"));
const env = { ...process.env, SPECILLUM_PORT: port, SPECILLUM_PROFILE: profile };
const html = (title, body) => "data:text/html," + encodeURIComponent(`<title>${title}</title>${body}`);

async function agent(name) {
  const client = new Client({ name, version: "0.0.0" });
  await client.connect(new StdioClientTransport({ command: "node", args: ["dist/cli.js"], env }));
  const call = async (tool, args = {}) => {
    const res = await client.callTool({ name: tool, arguments: args });
    const out = res.content.map((c) => c.text ?? `[${c.type}]`).join("\n");
    if (res.isError) throw new Error(`${tool}: ${out}`);
    return out;
  };
  return { client, call };
}

const results = [];
async function check(name, fn) {
  const t0 = Date.now();
  try {
    const detail = await fn();
    results.push({ name, ok: true, ms: Date.now() - t0, detail });
    console.log(`PASS ${name} (${Date.now() - t0}ms)${detail ? " — " + detail : ""}`);
  } catch (err) {
    results.push({ name, ok: false, ms: Date.now() - t0, detail: String(err.message ?? err) });
    console.log(`FAIL ${name} (${Date.now() - t0}ms) — ${String(err.message ?? err).slice(0, 600)}`);
  }
}
const expect = (cond, msg) => {
  if (!cond) throw new Error(msg);
};
const ref = (snap, re) => snap.match(re)?.[1];

const a = await agent("alpha");
const b = await agent("beta");

try {
  await check("example.com: snapshot + click link", async () => {
    const s = await a.call("navigate", { url: "example.com", snapshot: true });
    const link = ref(s, /\[(e\d+)\] link "[^"]*(More information|Learn more)[^"]*"/i);
    expect(link, "no 'more information' link in snapshot:\n" + s);
    const r = await a.call("click", { ref: link });
    expect(/iana\.org/.test(r), "click did not reach iana.org:\n" + r);
  });

  await check("wikipedia: search box type + submit", async () => {
    const s = await a.call("navigate", { url: "https://en.wikipedia.org/wiki/Main_Page", snapshot: true });
    const box = ref(s, /\[(e\d+)\] (?:textbox|searchbox|textbox:search|combobox)[^\n]*Search Wikipedia/i);
    expect(box, "no search box in snapshot:\n" + s.split("elements:")[1]?.slice(0, 1500));
    const r = await a.call("type", { ref: box, text: "Model Context Protocol", submit: true });
    expect(/Model Context Protocol|Search results/i.test(r), "search did not land:\n" + r);
    return `snapshot ${s.length} chars`;
  });

  await check("hacker news: read + snapshot size", async () => {
    await a.call("navigate", { url: "https://news.ycombinator.com" });
    const text = await a.call("read", { maxChars: 1500 });
    expect(/points|comments/i.test(text), "front page text missing:\n" + text);
    const s = await a.call("snapshot");
    return `snapshot ${s.length} chars, ${(s.match(/^\[/gm) ?? []).length} elements`;
  });

  await check("github: read this repo's README", async () => {
    await a.call("navigate", { url: "https://github.com/jasonwpgml/specillum" });
    const text = await a.call("read", { maxChars: 4000 });
    expect(/Isolated browser pods/i.test(text), "README text missing:\n" + text.slice(0, 1000));
    const s = await a.call("snapshot");
    return `snapshot ${s.length} chars`;
  });

  await check("github: in-place page swap is finished when click returns", async () => {
    const s = await a.call("navigate", { url: "https://github.com/jasonwpgml/specillum", snapshot: true });
    const link = ref(s, /\[(e\d+)\] link "README\.ko\.md[^"]*"/);
    expect(link, "no README.ko.md link:\n" + s.slice(0, 2000));
    const r = await a.call("click", { ref: link });
    expect(/url: [^\n]*README\.ko\.md/.test(r), "click returned before the new page:\n" + r);
  });

  await check("logins are shared live between pods (cookies)", async () => {
    await a.call("navigate", { url: "https://httpbin.org/cookies/set?specillum=shared-login" });
    await b.call("navigate", { url: "https://httpbin.org/cookies" });
    const text = await b.call("read");
    expect(text.includes("shared-login"), "beta does not see alpha's cookie:\n" + text);
  });

  await check("iframes: same-origin and cross-origin elements get refs", async () => {
    const page = html(
      "Frames",
      `<h1>outer</h1><iframe width=400 height=120 srcdoc="<button onclick=&quot;parent.document.title='inner-clicked'&quot;>Inner button</button>"></iframe>` +
        `<iframe width=500 height=300 src="https://example.com/"></iframe>`,
    );
    await a.call("navigate", { url: page });
    await new Promise((r) => setTimeout(r, 2000));
    const s = await a.call("snapshot");
    const inner = ref(s, /\[(f\d+e\d+)\] button "Inner button"/);
    const cross = ref(s, /\[(f\d+e\d+)\] link "[^"]*(More information|Learn more)/i);
    expect(inner, "same-origin iframe button missing:\n" + s);
    expect(cross, "cross-origin iframe link missing:\n" + s);
    const r = await a.call("click", { ref: inner });
    expect(r.includes("inner-clicked"), "iframe click had no effect:\n" + r);
  });

  await check("dialogs: confirm dismissed by default, accepted when armed", async () => {
    const page = html("Dialog", `<button onclick="document.title = confirm('Delete everything?') ? 'yes' : 'no'">Delete</button>`);
    let s = await a.call("navigate", { url: page, snapshot: true });
    let r = await a.call("click", { ref: ref(s, /\[(e\d+)\] button "Delete"/) });
    expect(/confirm dialog "Delete everything\?" was dismissed/.test(r) && /title: no/.test(r), "default dismiss failed:\n" + r);
    await a.call("dialog", { action: "accept" });
    s = await a.call("snapshot");
    r = await a.call("click", { ref: ref(s, /\[(e\d+)\] button "Delete"/) });
    expect(/was accepted/.test(r) && /title: yes/.test(r), "armed accept failed:\n" + r);
  });

  await check("popups: target=_blank link becomes a pod tab and is reported", async () => {
    const page = html("Opener", `<a href="https://example.com/" target="_blank">Open example</a>`);
    const s = await a.call("navigate", { url: page, snapshot: true });
    const r = await a.call("click", { ref: ref(s, /\[(e\d+)\] link "Open example"/) });
    expect(/opened a new tab/.test(r), "popup not reported:\n" + r);
    const tabs = await a.call("tabs", { action: "list" });
    expect(tabs.includes("example.com") && tabs.includes("Opener"), "popup not in pod tabs:\n" + tabs);
    const bt = await b.call("tabs", { action: "list" });
    expect(!bt.includes("Opener"), "beta can see alpha's tabs:\n" + bt);
  });

  await check("screenshot returns an image", async () => {
    const res = await a.client.callTool({ name: "screenshot", arguments: {} });
    expect(res.content[0]?.type === "image" && res.content[0].data.length > 1000, "no image");
  });

  await check("station closed by the user: next call relaunches it", async () => {
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    await (await browser.newBrowserCDPSession()).send("Browser.close").catch(() => {});
    await new Promise((r) => setTimeout(r, 2000));
    const r = await a.call("navigate", { url: "example.com" });
    expect(/example\.com/.test(r), "did not recover:\n" + r);
  });
} finally {
  await a.client.close().catch(() => {});
  await b.client.close().catch(() => {});
  try {
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    await (await browser.newBrowserCDPSession()).send("Browser.close");
  } catch {}
  await new Promise((r) => setTimeout(r, 1500));
  rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exitCode = failed ? 1 : 0;
}
