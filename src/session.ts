// What every tool shares: this agent's pod, its view of the pages, and the way
// an action reports back.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Browser, Page } from "playwright-core";
import { z } from "zod";
import { PageView } from "./pageview.js";
import { Pod, type PodWindow } from "./pod.js";
import { connectStation } from "./station.js";

export type Content = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };
export const text = (t: string) => ({ content: [{ type: "text", text: t }] as Content[] });

export const snapshotFlag = z.union([z.boolean(), z.literal("changes")]).optional().describe('Also return a snapshot, or "changes" for only what changed.');

export class Session {
  readonly pages = new PageView();
  private browser: Browser | undefined;
  private pod: Pod | undefined;
  private readonly label = process.env.SPECILLUM_POD;
  private readonly mode = (process.env.SPECILLUM_POD_WINDOW ?? "visible") as PodWindow;

  constructor(private readonly server: McpServer) {
    const windowModes: PodWindow[] = ["visible", "minimized"];
    if (!windowModes.includes(this.mode)) throw new Error(`SPECILLUM_POD_WINDOW must be one of ${windowModes.join(", ")}`);
  }

  // The pod is created lazily so a pod window only appears once the agent
  // actually uses the browser, and it is labelled after the connecting client.
  // If the station was closed, the next call starts it again with a new pod.
  async getPod(): Promise<Pod> {
    if (this.pod && this.browser?.isConnected()) return this.pod;
    this.browser = await connectStation();
    this.browser.on("disconnected", () => {
      this.browser = undefined;
      this.pod = undefined;
    });
    const client = this.server.server.getClientVersion()?.name ?? "agent";
    this.pod = await Pod.launch(this.browser, this.label ?? `${client}-${Math.random().toString(36).slice(2, 6)}`, this.mode);
    return this.pod;
  }

  async page(): Promise<Page> {
    return (await this.getPod()).page();
  }

  async locate(ref: string) {
    const p = await this.page();
    return { p, loc: await this.pages.locate(p, ref) };
  }

  // Every action reports where the active tab ended up, plus anything that
  // happened on the way (dialogs, new tabs). With snapshot=true it also
  // returns a fresh snapshot so the agent saves a round trip.
  async after(note: string, withSnapshot?: boolean | "changes", settleMs = 100, since?: number) {
    const pd = await this.getPod();
    await pd.settle(settleMs, since);
    const p = await pd.page();
    await p.waitForLoadState("domcontentloaded", { timeout: 5000 }).catch(() => {});
    const events = pd.drainNotes().map((n) => `note: ${n}`);
    const head = [note, ...events].join("\n");
    if (withSnapshot) return text(`${head}\n${await this.pages.view(p, { changes: withSnapshot === "changes" })}`);
    return text(`${head}\nurl: ${p.url()}\ntitle: ${await p.title().catch(() => "")}`);
  }

  async close(): Promise<void> {
    await this.pod?.close();
  }
}
