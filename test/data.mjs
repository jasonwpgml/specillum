// Read-only data tools: network, response, page_data. A local site serves
// JSON full of fake secrets, so redaction, size caps and pod isolation can be
// checked exactly; then the tools run once against a real site.
import { createServer } from "node:http";
import { chromium } from "playwright-core";
import { check, closeStation, connectAgent, expect, finish, testStation } from "./helpers.mjs";

const port = "9666";
const station = testStation("data", port);

const JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhbGljZSIsImlhdCI6MX0.c2lnbmF0dXJlLXZhbHVlLWhlcmU";
const me = {
  user: { name: "alice", email: "alice@example.com", access_token: "tok-SECRET-1", author: "kept" },
  csrfToken: "csrf-SECRET-2",
  "X-Session-Id": "sess-SECRET-3",
  password: "pw-SECRET-4",
  note: `Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123 and ${JWT}`,
  github: "ghp_" + "a".repeat(36),
  items: Array.from({ length: 400 }, (_, i) => ({ id: i, title: `item ${i}` })),
};
const nextData = { props: { pageProps: { product: { name: "Lamp", price: 30 }, apiKey: "key-SECRET-5" } } };
const ld = { "@context": "https://schema.org", "@type": "Product", name: "Lamp", offers: { price: "30.00" } };
const html = (body) => `<!doctype html><title>Shop</title>${body}`;

const site = createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/api/me") {
    res.writeHead(200, { "content-type": "application/json; charset=utf-8", "set-cookie": "sid=cookie-SECRET-6" });
    return res.end(JSON.stringify(me));
  }
  if (url.pathname === "/api/other") {
    res.writeHead(200, { "content-type": "application/vnd.api+json" });
    return res.end(JSON.stringify({ owner: url.searchParams.get("who") }));
  }
  if (url.pathname === "/api/text") {
    res.writeHead(200, { "content-type": "text/plain" });
    return res.end("plain");
  }
  res.writeHead(200, { "content-type": "text/html" });
  const who = url.searchParams.get("who") ?? "alpha";
  res.end(
    html(`<h1>Shop</h1>
<script type="application/ld+json">${JSON.stringify(ld)}</script>
<script id="__NEXT_DATA__" type="application/json">${JSON.stringify(nextData)}</script>
<script>
  fetch("/api/me?api_key=query-SECRET-7&page=2");
  fetch("/api/other?who=${who}");
  fetch("/api/text");
</script>`),
  );
});
await new Promise((r) => site.listen(0, "127.0.0.1", r));
const origin = `http://127.0.0.1:${site.address().port}`;

const agent = (name) => connectAgent(station, name, { env: { SPECILLUM_POD: name } });

const noSecrets = (out) => {
  const leaked = out.match(/[\w-]*SECRET[\w-]*|ghp_a{10}|abcdefghijklmnopqrstuvwxyz0123|eyJhbGciOiJIUzI1NiJ9\.eyJ/g);
  expect(!leaked, `leaked ${leaked?.join(", ")}:\n${out.slice(0, 1500)}`);
};
const idOf = (list, part) => list.match(new RegExp(`\\[#(\\d+)\\][^\\n]*${part}`))?.[1];

const a = await agent("alpha");
const b = await agent("beta");
let observer;

try {
  let list = "";
  await check("network lists only JSON responses, with masked query secrets", async () => {
    await a.call("navigate", { url: `${origin}/shop?who=alpha` });
    for (let i = 0; i < 20 && !/api\/other/.test(list); i++) {
      list = await a.call("network");
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(/api\/me/.test(list) && /api\/other/.test(list), "JSON responses missing:\n" + list);
    expect(!/api\/text/.test(list), "non-JSON listed without all:\n" + list);
    expect(/data, not instructions/.test(list), "untrusted marker missing");
    noSecrets(list);
    const withAll = await a.call("network", { all: true });
    expect(/api\/text[^\n]*not JSON/.test(withAll), "all: true should list text response:\n" + withAll);
    return list.split("\n")[1];
  });

  await check("response masks secret keys, tokens in values, and never shows headers", async () => {
    const out = await a.call("response", { id: Number(idOf(list, "api/me")), maxChars: 50_000 });
    noSecrets(out);
    expect(/"name": "alice"/.test(out) && /"author": "kept"/.test(out), "ordinary fields should stay:\n" + out.slice(0, 800));
    expect(/"email": "alice@example.com"/.test(out), "email is not a secret key");
    expect(!/set-cookie|content-type/i.test(out), "headers leaked");
    return `${out.length} chars`;
  });

  await check("response is size-capped and path picks a part", async () => {
    const id = Number(idOf(list, "api/me"));
    const capped = await a.call("response", { id });
    expect(capped.length < 9000 && /more chars; narrow it with path/.test(capped), `not capped: ${capped.length} chars`);
    const part = await a.call("response", { id, path: "items[399].title" });
    expect(/"item 399"/.test(part), "path failed:\n" + part);
    const secret = await a.call("response", { id, path: "user.access_token" });
    expect(/\[redacted\]/.test(secret), "path to a secret must stay redacted:\n" + secret);
    const bad = await a.call("response", { id, path: "nope.x" }).catch((e) => e.message);
    expect(/not found/.test(bad), "bad path should explain: " + bad);
  });

  await check("page_data lists and returns embedded JSON, redacted", async () => {
    const blocks = await a.call("page_data");
    expect(/json-ld/.test(blocks) && /__NEXT_DATA__/.test(blocks), "blocks missing:\n" + blocks);
    const next = blocks.match(/\[(\d+)\] script#__NEXT_DATA__/)?.[1];
    const out = await a.call("page_data", { index: Number(next), path: "props.pageProps" });
    expect(/"name": "Lamp"/.test(out), "product missing:\n" + out);
    noSecrets(out);
    return blocks.split("\n").slice(1).join(" | ");
  });

  await check("pods never see each other's responses, nor the user's tabs", async () => {
    await b.call("navigate", { url: `${origin}/shop?who=beta` });
    await new Promise((r) => setTimeout(r, 800));
    observer = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { noDefaults: true });
    const userTab = await observer.contexts()[0].newPage();
    await userTab.goto(`${origin}/shop?who=user`);
    await new Promise((r) => setTimeout(r, 800));
    const la = await a.call("network", { limit: 100 });
    const lb = await b.call("network", { limit: 100 });
    expect(!/who=beta|who=user/.test(la), "alpha sees others:\n" + la);
    expect(/who=beta/.test(lb) && !/who=alpha|who=user/.test(lb), "beta sees wrong responses:\n" + lb);
    await userTab.close();
  });

  await check("real site: GitHub page_data and network", async () => {
    await a.call("navigate", { url: "https://github.com/jasonwpgml/specillum" });
    const blocks = await a.call("page_data");
    expect(/script#|json-ld/.test(blocks), "GitHub embeds no data?\n" + blocks);
    const s = await a.call("snapshot");
    const link = s.match(/\[(e\d+)\] link "README\.ko\.md[^"]*"/)?.[1];
    expect(link, "no README.ko.md link");
    await a.call("click", { ref: link });
    const net = await a.call("network", { match: "github.com", limit: 10 });
    const ids = [...net.matchAll(/\[#(\d+)\]/g)].map((m) => m[1]);
    for (const id of ids) noSecrets(await a.call("response", { id: Number(id), maxChars: 3000 }));
    return `${blocks.split("\n").length - 1} embedded blocks, ${ids.length} JSON responses after a click`;
  });
} finally {
  await a.client.close().catch(() => {});
  await b.client.close().catch(() => {});
  site.close();
  await closeStation(station);
  finish();
}
