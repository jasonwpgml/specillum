// End-to-end check: two agents connect at once, each gets its own pod window,
// neither can see the other's tabs, and a pod closes when its agent leaves.
// Uses a throwaway profile and port so it never touches your real station.
import { chromium } from "playwright-core";
import { closeStation, connectAgent, testStation } from "./helpers.mjs";

const port = "9444";
const station = testStation("smoke", port);

const page = (title, body) => "data:text/html," + encodeURIComponent(`<title>${title}</title>${body}`);
const FORM = page(
  "Form",
  `<h1>Sign up</h1><label>Email <input id=e></label><button onclick="document.title='sent:'+e.value">Send</button><a href="https://example.com/">Elsewhere</a>`,
);

const agent = (name) => connectAgent(station, name);

const assert = (cond, msg) => {
  if (!cond) throw new Error("FAIL: " + msg);
  console.log("ok -", msg);
};

let a, b;
try {
  [a, b] = await Promise.all([agent("alpha"), agent("beta")]);
  const { tools } = await a.client.listTools();
  console.log(`tools (${tools.length}):`, tools.map((t) => t.name).join(", "));

  await Promise.all([a.call("navigate", { url: FORM }), b.call("navigate", { url: page("Beta home", "<h1>beta</h1>") })]);

  const snap = await a.call("snapshot");
  console.log(snap);
  const input = snap.match(/\[(e\d+)\] textbox "Email"/)?.[1];
  const button = snap.match(/\[(e\d+)\] button "Send"/)?.[1];
  assert(input && button, "snapshot exposes refs for the input and button");

  await a.call("type", { ref: input, text: "pilot@example.com" });
  const clicked = await a.call("click", { ref: button });
  assert(clicked.includes("title: sent:pilot@example.com"), "type + click work through refs");

  await a.call("tabs", { action: "new", url: page("Alpha second", "<p>2</p>") });
  const aTabs = await a.call("tabs", { action: "list" });
  const bTabs = await b.call("tabs", { action: "list" });
  console.log("alpha tabs:\n" + aTabs + "\nbeta tabs:\n" + bTabs);
  assert(aTabs.split("\n").length === 2 && !aTabs.includes("Beta home"), "alpha sees only its own 2 tabs");
  assert(bTabs.split("\n").length === 1 && !bTabs.includes("sent:"), "beta sees only its own tab");

  // Look from outside: alpha's tabs share one window, beta has another.
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const cdp = await browser.newBrowserCDPSession();
  const { targetInfos } = await cdp.send("Target.getTargets");
  const windows = {};
  for (const t of targetInfos.filter((t) => t.type === "page")) {
    const { windowId } = await cdp.send("Browser.getWindowForTarget", { targetId: t.targetId });
    (windows[windowId] ??= []).push(t.title);
  }
  console.log("windows:", JSON.stringify(windows));
  const alphaWin = Object.values(windows).find((titles) => titles.includes("sent:pilot@example.com"));
  assert(alphaWin?.includes("Alpha second"), "alpha's new tab opened in alpha's own window");
  assert(!alphaWin.includes("Beta home"), "beta's tab lives in a different window");

  await a.client.close();
  await new Promise((r) => setTimeout(r, 1500));
  const left = (await cdp.send("Target.getTargets")).targetInfos.filter((t) => t.type === "page").map((t) => t.title);
  assert(!left.includes("Alpha second") && left.includes("Beta home"), "alpha's pod closed when alpha disconnected; beta untouched");

  await b.client.close();
  console.log("\nALL PASSED");
} catch (err) {
  console.error(err);
  process.exitCode = 1;
  await a?.client.close().catch(() => {});
  await b?.client.close().catch(() => {});
} finally {
  await closeStation(station);
}
