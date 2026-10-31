import { z } from "zod";
import { assertAllowed } from "../allowlist.js";
import { snapshotFlag } from "../session.js";
import type { Register } from "./index.js";

// localhost:3000 looks like a URL with the scheme "localhost", and a local server
// rarely speaks https.
export function toUrl(input: string): string {
  if (/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?([/?#]|$)/i.test(input)) return `http://${input}`;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(input) || /^(about|data|blob|javascript):/i.test(input)) return input;
  return `https://${input}`;
}

export const registerNavigationTools: Register = (server, session) => {
  server.registerTool(
    "navigate",
    {
      description: "Open a URL in the active tab of this pod.",
      inputSchema: { url: z.string().describe("Absolute URL, or a bare domain like example.com"), snapshot: snapshotFlag },
    },
    async ({ url, snapshot: s }) => {
      const p = await session.page();
      const target = toUrl(url);
      assertAllowed(target);
      const t0 = Date.now();
      await p.goto(target, { waitUntil: "domcontentloaded", timeout: 30_000 });
      // Sites keep rendering after DOMContentLoaded and may replace elements,
      // which would drop the refs a snapshot taken now hands out.
      return session.after("navigated", s, 0, t0);
    },
  );

  server.registerTool(
    "history",
    {
      description: "Go back or forward in the active tab's history.",
      inputSchema: { direction: z.enum(["back", "forward"]), snapshot: snapshotFlag },
    },
    async ({ direction, snapshot: s }) => {
      const p = await session.page();
      const t0 = Date.now();
      if (direction === "back") await p.goBack({ timeout: 15_000 });
      else await p.goForward({ timeout: 15_000 });
      return session.after(direction, s, 0, t0);
    },
  );
};
