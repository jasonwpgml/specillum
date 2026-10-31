// Read-only tools for the data behind a page.
import { z } from "zod";
import { UNTRUSTED, embeddedDataInPage, outline, pick, redactUrl, redactValue, render } from "../data.js";
import { text } from "../session.js";
import type { Register } from "./index.js";

const sizeOf = (chars: number) => (chars >= 1000 ? `${(chars / 1000).toFixed(1)}k` : `${chars}`);
const maxCharsSchema = z.number().int().min(200).max(50_000).optional().describe("Default 8000.");
const pathSchema = z.string().optional().describe('Part of the JSON to return, e.g. "data.items[0].title".');

export const registerDataTools: Register = (server, session) => {
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
      const pd = await session.getPod();
      const rows = pd.network.entries
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
      const pd = await session.getPod();
      const c = pd.network.entries.find((x) => x.id === id);
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
      const p = await session.page();
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
};
