// Cookies and web storage of the active tab's site. This group is only there
// when asked for by name: the station's cookies are the user's logins, shared
// with every pod. Cookie values are never shown, and only the active tab's site
// can be touched.
import type { Page } from "playwright-core";
import { z } from "zod";
import { UNTRUSTED, redactValue } from "../data.js";
import { text } from "../session.js";
import type { Register } from "./index.js";

type Web = "local" | "session";
const MAX_VALUE = 200;

const siteOf = (p: Page) => {
  const url = p.url();
  if (!/^https?:/.test(url)) throw new Error(`The active tab is on ${url}. Open a site first.`);
  return url;
};

const readWeb = (p: Page, kind: Web) =>
  p.evaluate((k) => {
    const store = k === "local" ? localStorage : sessionStorage;
    return Object.fromEntries(Array.from({ length: store.length }, (_, i) => [store.key(i)!, store.getItem(store.key(i)!) ?? ""]));
  }, kind);

function webLine(kind: Web, key: string, raw: string): string {
  let parsed: unknown = raw;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Plain text, masked as it is.
  }
  const masked = (redactValue({ [key]: parsed }) as Record<string, unknown>)[key];
  const shown = typeof masked === "string" ? masked : JSON.stringify(masked);
  return `${kind} ${key} = ${shown.length > MAX_VALUE ? `${shown.slice(0, MAX_VALUE)}… (${shown.length} chars)` : shown}`;
}

export const registerStorageTools: Register = (server, session) => {
  server.registerTool(
    "storage",
    {
      description:
        "List, set or delete the active tab's cookies, localStorage and sessionStorage. Cookie values are never shown, and secret-looking storage values are masked. Cookies are shared with every pod and with the user's own logins, so deleting a login cookie logs everyone out of that site.",
      inputSchema: {
        action: z.enum(["list", "set", "delete"]),
        kind: z.enum(["cookie", "local", "session"]).optional().describe("Required for set and delete. list shows all three by default."),
        name: z.string().optional().describe("Required for set and delete."),
        value: z.string().optional().describe("For set. A cookie set here lasts until the browser closes."),
      },
    },
    async ({ action, kind, name, value }) => {
      const p = await session.page();
      const url = siteOf(p);
      const cookies = p.context();
      if (action === "list") {
        const rows: string[] = [];
        if (!kind || kind === "cookie") {
          for (const c of await cookies.cookies(url)) rows.push(`cookie ${c.name} domain=${c.domain}${c.httpOnly ? " httpOnly" : ""}${c.secure ? " secure" : ""}${c.expires > 0 ? ` expires=${new Date(c.expires * 1000).toISOString().slice(0, 10)}` : ""}`);
        }
        for (const web of ["local", "session"] as const) {
          if (kind && kind !== web) continue;
          for (const [key, raw] of Object.entries(await readWeb(p, web))) rows.push(webLine(web, key, raw));
        }
        return text(rows.length ? `${UNTRUSTED}\n${rows.join("\n")}` : "Nothing stored for this site.");
      }
      if (!kind || !name) throw new Error(`${action} needs kind and name.`);
      if (action === "set" && value === undefined) throw new Error("set needs a value.");
      if (kind === "cookie") {
        if (action === "set") await cookies.addCookies([{ name, value: value!, url }]);
        else {
          const found = (await cookies.cookies(url)).filter((c) => c.name === name);
          if (!found.length) throw new Error(`No cookie named ${name} for this site.`);
          for (const c of found) await cookies.clearCookies({ name, domain: c.domain, path: c.path });
        }
      } else {
        await p.evaluate(
          ([k, n, v]) => {
            const store = k === "local" ? localStorage : sessionStorage;
            if (v === null) store.removeItem(n!);
            else store.setItem(n!, v);
          },
          [kind, name, action === "set" ? value! : null],
        );
      }
      return session.after(`${action === "set" ? "set" : "deleted"} ${kind} ${name}`, undefined, 0);
    },
  );
};
