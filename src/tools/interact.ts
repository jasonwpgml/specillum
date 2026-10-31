// Acting on the active tab, mostly by snapshot ref.
import { z } from "zod";
import { clickOn } from "../actions.js";
import { snapshotFlag } from "../session.js";
import type { Register } from "./index.js";

export const registerInteractTools: Register = (server, session) => {
  server.registerTool(
    "click",
    {
      description: "Click an element by its snapshot ref. If something covers it, the error names what, such as a cookie banner.",
      inputSchema: {
        ref: z.string().describe("Ref from the latest snapshot, e.g. e12"),
        double: z.boolean().optional(),
        button: z.enum(["left", "right", "middle"]).optional(),
        snapshot: snapshotFlag,
      },
    },
    async ({ ref, double, button, snapshot: s }) => {
      const { loc } = await session.locate(ref);
      await clickOn(loc, ref, { double, button });
      return session.after(`clicked ${ref}`, s);
    },
  );

  server.registerTool(
    "type",
    {
      description: "Type text into an input, textarea or contenteditable element by ref. Replaces existing text unless append is true.",
      inputSchema: {
        ref: z.string(),
        text: z.string(),
        append: z.boolean().optional(),
        submit: z.boolean().optional().describe("Press Enter after typing."),
        snapshot: snapshotFlag,
      },
    },
    async ({ ref, text: value, append, submit, snapshot: s }) => {
      const { p, loc } = await session.locate(ref);
      if (append) {
        await loc.click({ timeout: 10_000 });
        await p.keyboard.press("End");
        await p.keyboard.insertText(value);
      } else {
        await loc.fill(value, { timeout: 10_000 });
      }
      if (submit) await loc.press("Enter");
      return session.after(`typed into ${ref}`, s);
    },
  );

  server.registerTool(
    "press",
    {
      description: "Press a key or shortcut in the active tab, e.g. Enter, Escape, ArrowDown, Control+A.",
      inputSchema: { key: z.string(), snapshot: snapshotFlag },
    },
    async ({ key, snapshot: s }) => {
      const p = await session.page();
      await p.keyboard.press(key);
      return session.after(`pressed ${key}`, s);
    },
  );

  server.registerTool(
    "select",
    {
      description: "Choose option(s) in a <select> element by ref, matching option value or label.",
      inputSchema: { ref: z.string(), values: z.array(z.string()).min(1), snapshot: snapshotFlag },
    },
    async ({ ref, values, snapshot: s }) => {
      const { loc } = await session.locate(ref);
      const chosen = await loc.selectOption(values.map((v) => ({ label: v })), { timeout: 3000 }).catch(() => loc.selectOption(values, { timeout: 10_000 }));
      return session.after(`selected ${chosen.join(", ")} in ${ref}`, s);
    },
  );

  server.registerTool(
    "hover",
    {
      description: "Move the mouse over an element by ref (opens hover menus, tooltips).",
      inputSchema: { ref: z.string(), snapshot: snapshotFlag },
    },
    async ({ ref, snapshot: s }) => {
      const { loc } = await session.locate(ref);
      await loc.hover({ timeout: 10_000 });
      return session.after(`hovered ${ref}`, s);
    },
  );

  server.registerTool(
    "drag",
    {
      description: "Drag one element onto another by ref, e.g. a card between columns.",
      inputSchema: { from: z.string(), to: z.string(), snapshot: snapshotFlag },
    },
    async ({ from, to, snapshot: s }) => {
      const source = await session.locate(from);
      const target = await session.locate(to);
      await source.loc.dragTo(target.loc, { timeout: 10_000 });
      return session.after(`dragged ${from} onto ${to}`, s);
    },
  );

  server.registerTool(
    "scroll",
    {
      description: "Scroll the page by screens, or scroll an element into view by ref.",
      inputSchema: {
        direction: z.enum(["up", "down"]).optional(),
        screens: z.number().min(0.1).max(20).optional().describe("Default 1."),
        ref: z.string().optional().describe("Scroll this element into view instead."),
        snapshot: snapshotFlag,
      },
    },
    async ({ direction, screens, ref, snapshot: s }) => {
      if (ref) {
        const { loc } = await session.locate(ref);
        await loc.scrollIntoViewIfNeeded({ timeout: 10_000 });
        return session.after(`scrolled to ${ref}`, s);
      }
      const p = await session.page();
      const sign = direction === "up" ? -1 : 1;
      await p.evaluate((dy) => window.scrollBy(0, dy * window.innerHeight), sign * (screens ?? 1));
      return session.after(`scrolled ${direction ?? "down"}`, s);
    },
  );
};
