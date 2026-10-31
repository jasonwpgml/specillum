// Stable refs, change-only snapshots, covered clicks, uploads, console, drag,
// downloads and the domain allowlist, against a local site.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";

const port = "9778";
const profile = mkdtempSync(join(tmpdir(), "specillum-features-"));
const workdir = mkdtempSync(join(tmpdir(), "specillum-features-cwd-"));
const outside = mkdtempSync(join(tmpdir(), "specillum-features-out-"));
writeFileSync(join(workdir, "notes.txt"), "hello");
writeFileSync(join(outside, "secret.txt"), "secret");
mkdirSync(join(workdir, "sub"));
// Keeps the test's download out of the real Downloads folder.
mkdirSync(join(profile, "Default"));
writeFileSync(join(profile, "Default", "Preferences"), JSON.stringify({ download: { default_directory: outside, prompt_for_download: false } }));
const base = { ...process.env, SPECILLUM_PORT: port, SPECILLUM_PROFILE: profile };

const html = (title, body) => `<!doctype html><meta charset=utf-8><title>${title}</title>${body}`;
const site = createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  res.setHeader("content-type", "text/html; charset=utf-8");
  if (url.pathname === "/list") {
    return res.end(html("List", `<button>Alpha</button><button>Beta</button><div id=more></div>
<button onclick="more.innerHTML='<button>Gamma</button>'">Add</button><button onclick="this.previousElementSibling.previousElementSibling.previousElementSibling.remove()">Drop</button>
<input id=val aria-label=Value>${Array.from({ length: 30 }, (_, i) => `<button>Filler ${i}</button>`).join("")}`));
  }
  if (url.pathname === "/frame") return res.end(html("Frame", "<button>In frame</button>"));
  if (url.pathname === "/frames") return res.end(html("Frames", `<h1>Home</h1>${'<iframe src="/frame" width=100 height=50></iframe>'.repeat(20)}`));
  if (url.pathname === "/banner") {
    return res.end(html("Banner", `<button onclick="document.title='clicked'">Buy</button>
<div id=consent style="position:fixed;inset:0;background:#fff">We use cookies <button onclick="consent.remove()">Accept</button></div>`));
  }
  if (url.pathname === "/upload") {
    return res.end(html("Upload", `<input type=file id=f style="display:none" onchange="document.title='got '+this.files[0].name">
<button onclick="f.click()">Choose</button>`));
  }
  if (url.pathname === "/logs") {
    return res.end(html("Logs", `<script>console.log('plain line');console.error('bad thing token ghp_${"a".repeat(36)}');setTimeout(()=>{throw new Error('boom')},0)</script>`));
  }
  if (url.pathname === "/drag") {
    return res.end(html("Drag", `<div id=a draggable=true style="width:80px;height:80px;background:#ccc" role=button aria-label=Card ondragstart="event.dataTransfer.setData('text','x')">Card</div>
<div id=b role=button aria-label=Column style="width:200px;height:200px;margin-top:40px;background:#eee" ondragover="event.preventDefault()" ondrop="document.title='dropped'">Column</div>`));
  }
  if (url.pathname === "/file") {
    res.setHeader("content-type", "application/octet-stream");
    res.setHeader("content-disposition", 'attachment; filename="report.bin"');
    return res.end("data");
  }
  if (url.pathname === "/dl") return res.end(html("Dl", `<a href="/file">Get report</a>`));
  if (url.pathname === "/slow") return res.end(html("Slow", `<p id=l>Loading</p><script>setTimeout(()=>{l.textContent='Ready';history.pushState({},'','/slow/done')},500)</script>`));
  if (url.pathname === "/popup") return res.end(html("Popup", `<button onclick="window.open('http://localhost:${site.address().port}/away')">Open</button><a href="http://localhost:${site.address().port}/away">Leave</a><a href="/bounce">Bounce</a>`));
  if (url.pathname === "/bounce") {
    res.writeHead(302, { location: `http://localhost:${site.address().port}/away` });
    return res.end();
  }
  res.end(html("Home", "<h1>Home</h1>"));
});
await new Promise((r) => site.listen(0, "127.0.0.1", r));
const origin = `http://127.0.0.1:${site.address().port}`;
const outsider = `http://localhost:${site.address().port}`;

async function agent(name, env = {}, cwd = workdir) {
  const client = new Client({ name, version: "0.0.0" });
  await client.connect(new StdioClientTransport({ command: "node", args: [join(process.cwd(), "dist/cli.js")], cwd, env: { ...base, SPECILLUM_POD: name, ...env } }));
  const call = async (tool, args = {}) => {
    const res = await client.callTool({ name: tool, arguments: args });
    const out = res.content.map((c) => c.text ?? `[${c.type}]`).join("\n");
    if (res.isError) throw new Error(`${tool}: ${out}`);
    return out;
  };
  const fails = (tool, args) => call(tool, args).then((out) => { throw new Error(`${tool} should have failed:\n${out}`); }, (e) => e.message);
  return { client, call, fails };
}

const expect = (cond, msg) => {
  if (!cond) throw new Error(msg);
};
const refOf = (snap, line) => {
  const ref = new RegExp(`\\[(\\S+?)\\] ${line}`).exec(snap)?.[1];
  expect(ref, `no ref for ${line} in:\n${snap}`);
  return ref;
};

let failed = 0;
async function check(name, fn) {
  try {
    const d = await fn();
    console.log(`PASS ${name}${d ? " — " + d : ""}`);
  } catch (e) {
    failed++;
    console.log(`FAIL ${name} — ${String(e.message ?? e).slice(0, 1500)}`);
  }
}

let a, walled;
try {
  a = await agent("feat");
  await check("an element keeps its ref when the page around it changes", async () => {
    const first = await a.call("navigate", { url: `${origin}/list`, snapshot: true });
    const beta = refOf(first, 'button "Beta"');
    await a.call("click", { ref: refOf(first, 'button "Add"') });
    const second = await a.call("snapshot");
    expect(refOf(second, 'button "Beta"') === beta, "Beta's ref moved:\n" + second);
    expect(refOf(second, 'button "Gamma"'), "Gamma missing");
    await a.call("click", { ref: beta });
  });

  await check("changes reports only what changed, and nothing when nothing did", async () => {
    await a.call("navigate", { url: `${origin}/list` });
    const full = await a.call("snapshot");
    expect((await a.call("snapshot", { changes: true })).startsWith("unchanged"), "expected unchanged");
    const delta = await a.call("click", { ref: refOf(full, 'button "Add"'), snapshot: "changes" });
    expect(/^\+ \[e\d+\] button "Gamma"/m.test(delta), "no addition:\n" + delta);
    expect(!delta.includes('"Alpha"'), "untouched element repeated:\n" + delta);
    const removed = await a.call("click", { ref: refOf(full, 'button "Drop"'), snapshot: "changes" });
    expect(/^- \[e\d+\] button "Beta"/m.test(removed) || /^- \[e\d+\] button "Alpha"/m.test(removed), "no removal:\n" + removed);
    const typed = await a.call("type", { ref: refOf(full, 'textbox "Value"'), text: "x", snapshot: "changes" });
    expect(/^~ \[e\d+\] textbox "Value" value="x"/m.test(typed), "no change line:\n" + typed);
  });

  await check("changes falls back to a full snapshot after a reload", async () => {
    await a.call("navigate", { url: `${origin}/list` });
    await a.call("snapshot");
    await a.call("evaluate", { expression: "location.reload()" }).catch(() => {});
    await a.call("wait", { seconds: 1 });
    const out = await a.call("snapshot", { changes: true });
    expect(out.includes("elements:") && out.includes('"Alpha"'), "expected full:\n" + out);
  });

  await check("a ref from before a reload never names an element after it", async () => {
    const before = await a.call("navigate", { url: `${origin}/list`, snapshot: true });
    const old = refOf(before, 'button "Beta"');
    await a.call("navigate", { url: `${origin}/list` });
    const now = await a.call("snapshot");
    expect(refOf(now, 'button "Beta"') !== old, "ref was reused:\n" + now);
    const msg = await a.fails("click", { ref: old });
    expect(msg.includes("not found"), msg);
  });

  await check("a bare local address opens over http", async () => {
    const out = await a.call("navigate", { url: `localhost:${site.address().port}/` });
    expect(out.includes(`url: ${outsider}/`), out);
  });

  await check("a snapshot reads many iframes, and within the element limit", async () => {
    await a.call("navigate", { url: `${origin}/frames` });
    await a.call("wait", { text: "Home", seconds: 1 }).catch(() => {});
    const all = await a.call("snapshot");
    expect(/\[f\d+e\d+\] button "In frame"/.test(all), all);
    const capped = await a.call("snapshot", { maxElements: 10 });
    expect(capped.split("\n").filter((l) => /^\[/.test(l)).length <= 10, capped);
    expect(/more elements not shown/.test(capped), capped);
  });

  await check("match finds one element without the rest of the page", async () => {
    await a.call("navigate", { url: `${origin}/list` });
    const out = await a.call("snapshot", { match: "bet" });
    expect(out.includes('button "Beta"') && !out.includes('"Alpha"') && out.includes('(1 elements match "bet")'), out);
    const msg = await a.fails("snapshot", { match: "x", changes: true });
    expect(msg.includes("not both"), msg);
  });

  await check("a covered click names what is in the way, soon", async () => {
    const snap = await a.call("navigate", { url: `${origin}/banner`, snapshot: true });
    const t0 = Date.now();
    const msg = await a.fails("click", { ref: refOf(snap, 'button "Buy"') });
    expect(/covered by <div#consent> "We use cookies/.test(msg), msg);
    expect(Date.now() - t0 < 8000, `took ${Date.now() - t0}ms`);
    await a.call("click", { ref: refOf(snap, 'button "Accept"') });
    const ok = await a.call("click", { ref: refOf(snap, 'button "Buy"') });
    expect(ok.includes("title: clicked"), ok);
  });

  await check("upload fills a hidden input, and through a button's file picker", async () => {
    const snap = await a.call("navigate", { url: `${origin}/upload`, snapshot: true });
    const direct = await a.call("upload", { paths: ["notes.txt"] });
    expect(direct.includes("title: got notes.txt"), direct);
    await a.call("evaluate", { expression: "(document.title='reset')" });
    const viaButton = await a.call("upload", { paths: ["notes.txt"], ref: refOf(snap, 'button "Choose"') });
    expect(viaButton.includes("title: got notes.txt"), viaButton);
  });

  await check("upload refuses files outside the agent's directory", async () => {
    await a.call("navigate", { url: `${origin}/upload` });
    let msg = await a.fails("upload", { paths: [join(outside, "secret.txt")] });
    expect(msg.includes("outside the directories"), msg);
    msg = await a.fails("upload", { paths: ["../" + outside.split(/[\\/]/).pop() + "/secret.txt"] });
    expect(msg.includes("outside the directories"), msg);
    msg = await a.fails("upload", { paths: ["sub"] });
    expect(msg.includes("Not a file"), msg);
    try {
      symlinkSync(join(outside, "secret.txt"), join(workdir, "link.txt"));
    } catch {
      return "symlink check skipped: not permitted here";
    }
    msg = await a.fails("upload", { paths: ["link.txt"] });
    expect(msg.includes("outside the directories"), msg);
  });

  await check("console shows this pod's messages and errors, with secrets masked", async () => {
    await a.call("navigate", { url: `${origin}/logs` });
    await a.call("wait", { seconds: 0.3 });
    const all = await a.call("console");
    expect(all.includes("log: plain line") && all.includes("uncaught Error: boom"), all);
    expect(all.includes("[redacted]") && !all.includes("ghp_"), all);
    const errors = await a.call("console", { errors: true });
    expect(!errors.includes("plain line") && errors.includes("bad thing"), errors);
    const other = await agent("feat-other");
    const theirs = await other.call("console");
    await other.client.close();
    expect(theirs.startsWith("No matching"), "saw another pod's console:\n" + theirs);
  });

  await check("drag drops one element on another", async () => {
    const snap = await a.call("navigate", { url: `${origin}/drag`, snapshot: true });
    const out = await a.call("drag", { from: refOf(snap, 'button "Card"'), to: refOf(snap, 'button "Column"') });
    expect(out.includes("title: dropped"), out);
  });

  await check("wait follows text going away and the URL changing", async () => {
    await a.call("navigate", { url: `${origin}/slow` });
    const out = await a.call("wait", { gone: "Loading", url: "/slow/done", seconds: 5 });
    expect(out.includes('"Loading" is gone') && out.includes("url: " + origin + "/slow/done"), out);
    const msg = await a.fails("wait", { url: "/never", seconds: 0.5 });
    expect(/timeout|exceeded/i.test(msg), msg);
  });

  await check("a download is reported", async () => {
    const snap = await a.call("navigate", { url: `${origin}/dl`, snapshot: true });
    const out = await a.call("click", { ref: refOf(snap, 'link "Get report"') });
    expect(out.includes("download started: report.bin"), out);
  });

  await check("an annotated screenshot leaves the page as it was", async () => {
    await a.call("navigate", { url: `${origin}/list` });
    const res = await a.client.callTool({ name: "screenshot", arguments: { annotate: true } });
    expect(res.content[0].type === "image", "no image");
    const left = await a.call("evaluate", { expression: "document.getElementById('__specillum-labels') === null" });
    expect(left.includes("true"), "labels stayed on the page");
  });

  await check("read and snapshot mark page content as untrusted", async () => {
    await a.call("navigate", { url: `${origin}/` });
    expect((await a.call("read")).startsWith("(Data below came from the website"), "read");
    expect((await a.call("snapshot")).startsWith("(Data below came from the website"), "snapshot");
  });

  walled = await agent("walled", { SPECILLUM_ALLOWED_DOMAINS: "127.0.0.1" });
  await check("the allowlist stops every way out of the listed sites", async () => {
    const snap = await walled.call("navigate", { url: `${origin}/popup`, snapshot: true });
    let msg = await walled.fails("navigate", { url: `${outsider}/` });
    expect(msg.includes("outside SPECILLUM_ALLOWED_DOMAINS"), msg);
    msg = await walled.fails("tabs", { action: "new", url: `${outsider}/` });
    expect(msg.includes("outside SPECILLUM_ALLOWED_DOMAINS"), msg);
    msg = await walled.fails("navigate", { url: "file:///etc/hosts" });
    expect(msg.includes("outside SPECILLUM_ALLOWED_DOMAINS"), msg);

    const link = await walled.call("click", { ref: refOf(snap, 'link "Leave"') });
    expect(link.includes("note: blocked") && link.includes(`url: ${origin}/popup`), "link should stay put:\n" + link);

    const popup = await walled.call("click", { ref: refOf(snap, 'button "Open"') });
    await walled.call("wait", { seconds: 0.5 });
    const tabs = await walled.call("tabs", { action: "list" });
    expect(!tabs.includes("localhost"), `popup got out:\n${popup}\n${tabs}`);
    await walled.call("tabs", { action: "close" });

    const bounced = await walled.call("click", { ref: refOf(snap, 'link "Bounce"') });
    await walled.call("wait", { seconds: 0.5 });
    const final = await walled.call("tabs", { action: "list" });
    expect(!final.includes("localhost"), `redirect got out:\n${bounced}\n${final}`);
  });
  await check("the allowlist lets the listed site work", async () => {
    const out = await walled.call("navigate", { url: `${origin}/` });
    expect(out.includes("title: Home"), out);
  });
  await check("the unlisted agent is not walled in by another pod's allowlist", async () => {
    const out = await a.call("navigate", { url: `${outsider}/` });
    expect(out.includes("title: Home"), out);
  });
} finally {
  await a?.client.close().catch(() => {});
  await walled?.client.close().catch(() => {});
  try {
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    await (await browser.newBrowserCDPSession()).send("Browser.close");
  } catch {}
  site.closeAllConnections();
  site.close();
  await new Promise((r) => setTimeout(r, 1000));
  for (const dir of [profile, workdir, outside]) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
}
console.log(failed ? `${failed} FAILED` : "ALL PASSED");
process.exit(failed ? 1 : 0);
