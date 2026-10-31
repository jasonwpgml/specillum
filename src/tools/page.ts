// Looking at the active tab and waiting for it.
import { z } from "zod";
import { UNTRUSTED } from "../data.js";
import { snapshotFlag, text, type Content } from "../session.js";
import { REF_ATTR, annotateInPage, readInPage } from "../snapshot.js";
import type { Register } from "./index.js";

export const registerPageTools: Register = (server, session) => {
  server.registerTool(
    "snapshot",
    {
      description:
        "Compact text view of the active tab: title, URL, headings, and visible interactive elements tagged with refs like [e12]. Use the refs with click, type, select and hover. An element keeps its ref until it leaves the page or the page reloads.",
      inputSchema: {
        maxElements: z.number().int().min(10).max(1000).optional().describe("Default 150."),
        match: z.string().optional().describe("Only elements whose line contains this text, searching up to 1000 elements. Finds one control on a long page cheaply."),
        changes: z.boolean().optional().describe("Only what changed since your last snapshot of this tab. Falls back to a full snapshot after a navigation. Not with match."),
      },
    },
    async ({ maxElements, match, changes }) => {
      if (match && changes) throw new Error("Use match or changes, not both.");
      return text(await session.pages.view(await session.page(), { maxElements, match, changes }));
    },
  );

  server.registerTool(
    "read",
    {
      description: "Read the visible text of the page (main content by default) as plain text.",
      inputSchema: {
        selector: z.string().optional().describe("CSS selector to read instead of the main content."),
        maxChars: z.number().int().min(200).max(100_000).optional().describe("Default 8000."),
      },
    },
    async ({ selector, maxChars }) => {
      const p = await session.page();
      return text(`${UNTRUSTED}\n${await p.evaluate(readInPage, { selector, maxChars: maxChars ?? 8000 })}`);
    },
  );

  server.registerTool(
    "wait",
    {
      description:
        "Wait for text to appear or go away, for the URL to change, or for a fixed time. After asking the user to log in through pod_window, wait for the URL they will land on.",
      inputSchema: {
        text: z.string().optional(),
        gone: z.string().optional().describe("Wait until this text is no longer visible, e.g. a loading message."),
        url: z.string().optional().describe("Wait until the tab's URL contains this."),
        seconds: z.number().min(0).max(300).optional().describe("Fixed wait, or the timeout when waiting for something (default 10)."),
        snapshot: snapshotFlag,
      },
    },
    async ({ text: needle, gone, url, seconds, snapshot: s }) => {
      const p = await session.page();
      const timeout = (seconds ?? 10) * 1000;
      if (needle) await p.getByText(needle).first().waitFor({ timeout });
      if (gone) await p.getByText(gone).first().waitFor({ state: "hidden", timeout });
      if (url) await p.waitForURL((u) => u.href.includes(url), { timeout, waitUntil: "commit" });
      const waited = [needle && `found "${needle}"`, gone && `"${gone}" is gone`, url && `url contains "${url}"`].filter(Boolean).join(", ");
      if (!waited) await p.waitForTimeout((seconds ?? 1) * 1000);
      return session.after(waited || `waited ${seconds ?? 1}s`, s, 0);
    },
  );

  server.registerTool(
    "screenshot",
    {
      description: "Take a JPEG screenshot of the active tab. Prefer snapshot for reading; use this for visual checks.",
      inputSchema: {
        fullPage: z.boolean().optional(),
        annotate: z.boolean().optional().describe("Label each element with its ref, so what you see can be clicked by ref."),
      },
    },
    async ({ fullPage, annotate }) => {
      const pd = await session.getPod();
      const p = await pd.page();
      const label = (on: boolean) => Promise.all(p.frames().map((f) => f.evaluate(annotateInPage, { refAttr: REF_ATTR, on }).catch(() => {})));
      if (annotate) {
        await session.pages.snapshot(p, 1000);
        await label(true);
      }
      try {
        const buf = await pd.screenshot(p, fullPage);
        return { content: [{ type: "image", data: buf.toString("base64"), mimeType: "image/jpeg" }] as Content[] };
      } finally {
        if (annotate) await label(false);
      }
    },
  );
};
