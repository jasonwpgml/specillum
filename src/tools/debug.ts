// For when a page misbehaves. evaluate is here because it can do anything the
// page can, so leaving this group out also takes that away.
import { z } from "zod";
import { UNTRUSTED, redactString } from "../data.js";
import { text } from "../session.js";
import type { Register } from "./index.js";

export const registerDebugTools: Register = (server, session) => {
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
      const pd = await session.getPod();
      const rows = pd.console.entries
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
    "mock",
    {
      description:
        "Give this pod's tabs a fake answer to requests whose URL contains some text, to test how a page handles an error or empty data. Page navigations are never mocked. Mocks last until cleared.",
      inputSchema: {
        action: z.enum(["add", "list", "clear"]),
        match: z.string().optional().describe("Required for add. Text the request URL contains."),
        status: z.number().int().min(100).max(599).optional().describe("Default 200."),
        body: z.string().optional(),
        contentType: z.string().optional().describe("Default application/json."),
        abort: z.boolean().optional().describe("Fail the request as a network error instead of answering."),
      },
    },
    async ({ action, match, status, body, contentType, abort }) => {
      const pd = await session.getPod();
      if (action === "add") {
        if (!match) throw new Error("add needs match.");
        await pd.page();
        await pd.mocks.add({ match, status: status ?? 200, body: body ?? "", contentType: contentType ?? "application/json", abort: abort ?? false }, pd.pages);
        return text(`mocking requests containing "${match}"; ${pd.mocks.entries.length} active`);
      }
      if (action === "clear") {
        await pd.mocks.clear(pd.pages);
        return text("all mocks cleared");
      }
      const rows = pd.mocks.entries.map((m) => `"${m.match}" -> ${m.abort ? "network error" : `${m.status} ${m.contentType}, ${m.body.length} chars`}`);
      return text(rows.length ? rows.join("\n") : "No mocks.");
    },
  );

  server.registerTool(
    "evaluate",
    {
      description: "Run a JavaScript expression in the active tab and return the JSON result. For reading data the other tools do not expose.",
      inputSchema: { expression: z.string().describe("Expression or async IIFE, e.g. document.querySelectorAll('li').length") },
    },
    async ({ expression }) => {
      const p = await session.page();
      const result = await p.evaluate(`(async () => (${expression}))()`);
      return text(JSON.stringify(result, null, 2) ?? "undefined");
    },
  );
};
