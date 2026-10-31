// The pod itself: its window, its tabs, and how it answers dialogs.
import { z } from "zod";
import { assertAllowed } from "../allowlist.js";
import type { Pod } from "../pod.js";
import { text } from "../session.js";
import { headless } from "../station.js";
import type { Register } from "./index.js";
import { toUrl } from "./navigation.js";

const tabList = async (pd: Pod) => {
  const short = (u: string) => (u.length > 120 ? u.slice(0, 119) + "…" : u);
  const lines = await Promise.all(
    pd.pages.map(async (p, i) => `${i === pd.activeIndex() ? "*" : " "} [${i}] ${await p.title().catch(() => "")} — ${short(p.url())}`),
  );
  return lines.join("\n");
};

export const registerPodTools: Register = (server, session) => {
  server.registerTool(
    "pod_status",
    {
      description:
        "Show this agent's pod: its label and the tabs it owns. The pod is a private browser window in the shared, logged-in Specillum Chrome. Other agents' pods and the user's own tabs are never visible here.",
      inputSchema: {},
    },
    async () => {
      const pd = await session.getPod();
      await pd.page();
      return text(`pod: ${pd.label} (window: ${pd.mode})\ntabs:\n${await tabList(pd)}`);
    },
  );

  server.registerTool(
    "pod_window",
    {
      description:
        "Show this pod's window to the user or minimize it to the taskbar, e.g. when the user asks to watch, or when you need them to log in or solve a CAPTCHA.",
      inputSchema: { state: z.enum(["show", "minimize"]) },
    },
    async ({ state }) => {
      if (state === "show" && headless()) throw new Error("SPECILLUM_HEADLESS is set, so there is no window to show. The user can log in with `specillum open` after closing the station.");
      const pd = await session.getPod();
      await pd.setWindowState(state === "show" ? "normal" : "minimized");
      return text(state === "show" ? "pod window is shown" : "pod window is minimized");
    },
  );

  server.registerTool(
    "tabs",
    {
      description: "Manage the tabs of this pod only: list, open a new tab (optionally at a URL), switch to a tab, or close one.",
      inputSchema: {
        action: z.enum(["list", "new", "select", "close"]),
        index: z.number().int().min(0).optional().describe("Tab index for select/close (close defaults to the active tab)."),
        url: z.string().optional().describe("URL for a new tab."),
      },
    },
    async ({ action, index, url }) => {
      const pd = await session.getPod();
      if (action === "new") {
        const target = url && toUrl(url);
        if (target) assertAllowed(target);
        await pd.newTab(target);
      }
      if (action === "select") {
        const p = pd.select(index ?? 0);
        await p.bringToFront();
      }
      if (action === "close") {
        const p = index === undefined ? await pd.page() : pd.select(index);
        await p.close();
      }
      if (pd.pages.length === 0) await pd.page();
      return text(await tabList(pd));
    },
  );

  server.registerTool(
    "dialog",
    {
      description:
        "Decide how to answer the next JavaScript dialog (confirm, prompt, beforeunload) before the action that triggers it. Without this, alerts are accepted and confirms/prompts are dismissed; tool results report every dialog.",
      inputSchema: {
        action: z.enum(["accept", "dismiss"]),
        promptText: z.string().optional().describe("Text to enter when accepting a prompt()."),
      },
    },
    async ({ action, promptText }) => {
      const pd = await session.getPod();
      pd.nextDialog = { accept: action === "accept", promptText };
      return text(`the next dialog will be ${action === "accept" ? "accepted" : "dismissed"}`);
    },
  );
};
