// Recipes: saved steps replayed by role and name. A local site plays a map
// search with an iframe, a moving layout, a canvas and a password form, so a
// replay that goes wrong has to stop instead of carrying on.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";

const port = "9777";
const profile = mkdtempSync(join(tmpdir(), "specillum-recipes-"));
const recipes = join(profile, "..", `${profile.split(/[\\/]/).pop()}-recipes`);
const base = { ...process.env, SPECILLUM_PORT: port, SPECILLUM_PROFILE: profile, SPECILLUM_RECIPES: recipes };

const html = (title, body) => `<!doctype html><meta charset=utf-8><title>${title}</title>${body}`;
const site = createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  res.setHeader("content-type", "text/html; charset=utf-8");
  if (url.pathname === "/map") {
    // The button sits elsewhere in layout 2, and the box renders late.
    const gap = url.searchParams.get("layout") === "2" ? 500 : 0;
    return res.end(html("Map", `<div style="margin-top:${gap}px"><button onclick="document.title='clicked';document.getElementById('o').textContent='panel open'">Directions</button></div><p id=o></p>
<iframe id=search width=600 height=200></iframe>
<script>setTimeout(()=>{document.getElementById('search').src='/search'},700)</script>`));
  }
  if (url.pathname === "/search") {
    return res.end(html("Search", `<input placeholder="Search places" onkeydown="if(event.key==='Enter')location='/results?q='+encodeURIComponent(this.value)">`));
  }
  if (url.pathname === "/results") return res.end(html("Results", `<p>Results for ${url.searchParams.get("q")}</p>`));
  if (url.pathname === "/echo") return res.end(html("Echo", `<p>got ${url.searchParams.get("q")}</p>`));
  if (url.pathname === "/twins") return res.end(html("Twins", `<button onclick="document.title='first'">Save</button><button onclick="document.title='second'">Save</button>`));
  if (url.pathname === "/canvas") {
    return res.end(html("Canvas", `<style>body{margin:0}</style><canvas id=c width=400 height=400></canvas><p id=o></p>
<script>c.onclick=(e)=>{o.textContent=e.clientX<200?'west':'east'}</script>`));
  }
  if (url.pathname === "/login") return res.end(html("Login", `<input type=password role=textbox aria-label=Secret>`));
  if (url.pathname === "/away") {
    res.writeHead(302, { location: `http://localhost:${site.address().port}/echo?q=away` });
    return res.end();
  }
  res.end(html("Home", "<h1>Home</h1>"));
});
await new Promise((r) => site.listen(0, "127.0.0.1", r));
const origin = `http://127.0.0.1:${site.address().port}`;
const host = "127.0.0.1";

async function agent(name) {
  const client = new Client({ name, version: "0.0.0" });
  await client.connect(new StdioClientTransport({ command: "node", args: ["dist/cli.js"], env: { ...base, SPECILLUM_POD: name } }));
  const call = async (tool, args = {}) => {
    const res = await client.callTool({ name: tool, arguments: args });
    const out = res.content.map((c) => c.text ?? `[${c.type}]`).join("\n");
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
    console.log(`FAIL ${name} — ${String(e.message ?? e).slice(0, 1500)}`);
  }
}
const expect = (c, m) => {
  if (!c) throw new Error(m);
};
const refused = async (promise, pattern) => {
  const out = await promise.then(
    (r) => {
      throw new Error("should have been refused, got: " + r);
    },
    (e) => e.message,
  );
  expect(pattern.test(out), `wrong refusal: ${out}`);
  return out;
};

const a = await agent("alpha");
const b = await agent("beta");
const recipe = (args) => a.call("recipe", args);
const save = (name, steps, params = []) => recipe({ action: "save", name, site: host, params, steps });

try {
  await check("a recipe searches inside a late iframe, with the value passed at run time", async () => {
    await save(
      "place_search",
      [
        { do: "goto", url: `${origin}/map` },
        { do: "type", role: "textbox", name: "Search places", text: "{query}", submit: true },
        { do: "expect", text: "Results for {query}" },
      ],
      ["query"],
    );
    const out = await recipe({ action: "run", name: "place_search", values: { query: "강남역 카페" } });
    expect(/ran recipe place_search: 3 steps/.test(out), out);
  });

  await check("another agent lists and runs the saved recipe in its own pod", async () => {
    const list = await b.call("recipe", { action: "list", site: host });
    expect(/place_search \(query\) on 127\.0\.0\.1, 3 steps/.test(list), list);
    await b.call("recipe", { action: "run", name: "place_search", values: { query: "second" } });
    const mine = await a.call("snapshot");
    expect(!/second/.test(mine), "beta's run reached alpha's pod:\n" + mine);
  });

  await check("clicks follow the element when the layout moves", async () => {
    await save("directions", [
      { do: "click", role: "button", name: "Directions" },
      { do: "expect", text: "panel open" },
    ]);
    for (const layout of [1, 2]) {
      await a.call("navigate", { url: `${origin}/map?layout=${layout}` });
      await recipe({ action: "run", name: "directions" });
    }
  });

  await check("goto encodes values; a value holding a placeholder stays literal", async () => {
    await save(
      "echo",
      [
        { do: "goto", url: `${origin}/echo?q={q}` },
        { do: "expect", text: "got {q}" },
      ],
      ["q"],
    );
    await recipe({ action: "run", name: "echo", values: { q: "a&b=c {q}" } });
  });

  await check("a failed expect stops the run and reports the step and page", async () => {
    await save("wrong", [
      { do: "goto", url: `${origin}/twins` },
      { do: "expect", text: "never here", seconds: 1 },
      { do: "click", role: "button", name: "Save", nth: 0 },
    ]);
    const out = await refused(recipe({ action: "run", name: "wrong" }), /stopped at step 2\/3/);
    expect(/\[e\d+\] button "Save"/.test(out), "no page state in report:\n" + out);
    expect((await a.call("evaluate", { expression: "document.title" })).includes("Twins"), "step 3 ran after the failure");
  });

  await check("several matches fail instead of guessing; nth chooses", async () => {
    await save("twins", [
      { do: "goto", url: `${origin}/twins` },
      { do: "click", role: "button", name: "Save" },
    ]);
    await refused(recipe({ action: "run", name: "twins" }), /2 elements match/);
    await save("twins", [
      { do: "goto", url: `${origin}/twins` },
      { do: "click", role: "button", name: "Save", nth: 1 },
    ]);
    await recipe({ action: "run", name: "twins" });
    expect((await a.call("evaluate", { expression: "document.title" })).includes("second"), "nth missed");
  });

  await check("a missing element fails with its role and name", async () => {
    await save("gone", [
      { do: "goto", url: `${origin}/` },
      { do: "click", role: "button", name: "Nothing" },
    ]);
    await refused(recipe({ action: "run", name: "gone" }), /No element matches button "Nothing"/);
  });

  await check("click_at needs an expect and the saved viewport", async () => {
    await refused(save("bad_canvas", [{ do: "click_at", x: 10, y: 10 }]), /must be followed by expect/);
    await save("canvas", [
      { do: "goto", url: `${origin}/canvas` },
      { do: "click_at", x: 300, y: 100 },
      { do: "expect", text: "east" },
    ]);
    await recipe({ action: "run", name: "canvas" });
    const file = join(recipes, "canvas.json");
    const saved = JSON.parse(readFileSync(file, "utf8"));
    writeFileSync(file, JSON.stringify({ ...saved, viewport: { width: 1, height: 1 } }));
    await refused(recipe({ action: "run", name: "canvas" }), /saved for a 1x1 viewport/);
  });

  await check("recipes stay on their site", async () => {
    await save("elsewhere", [{ do: "goto", url: "https://example.com/" }]);
    await refused(recipe({ action: "run", name: "elsewhere" }), /leaves the recipe's site/);
    await save("param_host", [{ do: "goto", url: "{u}" }], ["u"]);
    await refused(recipe({ action: "run", name: "param_host", values: { u: "https://example.com/" } }), /leaves the recipe's site/);
    await save("redirected", [
      { do: "goto", url: `${origin}/away` },
      { do: "click", role: "button", name: "Anything" },
    ]);
    await refused(recipe({ action: "run", name: "redirected" }), /not on the recipe's site/);
  });

  await check("password fields are refused at save and at run", async () => {
    await refused(save("pw", [{ do: "type", role: "textbox:password", name: "x", text: "y" }]), /never type into password/);
    await save("pw", [
      { do: "goto", url: `${origin}/login` },
      { do: "type", role: "textbox", name: "Secret", text: "y" },
    ]);
    await refused(recipe({ action: "run", name: "pw" }), /never type into password/);
  });

  await check("bad recipes and missing values are refused", async () => {
    await refused(save("../evil", [{ do: "press", key: "Enter" }]), /Recipe name must match/);
    await refused(save("undeclared", [{ do: "expect", text: "{nope}" }]), /\{nope\} is used/);
    await refused(save("unused", [{ do: "press", key: "Enter" }], ["q"]), /Parameter q is not used/);
    await refused(recipe({ action: "run", name: "echo" }), /needs values for: q/);
    await refused(recipe({ action: "run", name: "missing" }), /No recipe named missing/);
  });

  await check("failure reports keep run-time values out", async () => {
    await save(
      "private",
      [
        { do: "goto", url: `${origin}/` },
        { do: "expect", text: "{code}", seconds: 1 },
      ],
      ["code"],
    );
    const out = await refused(recipe({ action: "run", name: "private", values: { code: "VALUE-123" } }), /stopped at step 2/);
    expect(!/stopped[^\n]*VALUE-123/.test(out), "value in the step report:\n" + out);
  });

  await check("show and delete", async () => {
    const shown = await recipe({ action: "show", name: "echo" });
    expect(JSON.parse(shown).steps.length === 2, shown);
    await recipe({ action: "delete", name: "echo" });
    await refused(recipe({ action: "show", name: "echo" }), /No recipe named echo/);
  });
} finally {
  await a.client.close().catch(() => {});
  await b.client.close().catch(() => {});
  site.close();
  try {
    const br = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    await (await br.newBrowserCDPSession()).send("Browser.close");
  } catch {}
  await new Promise((r) => setTimeout(r, 1500));
  rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  rmSync(recipes, { recursive: true, force: true });
  console.log(failed ? `\n${failed} failed` : "\nALL PASSED");
  process.exitCode = failed ? 1 : 0;
}
