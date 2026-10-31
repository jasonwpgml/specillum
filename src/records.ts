// What a pod's pages did, kept for the agent to ask about later. Only the pod's
// own pages ever report here.
import type { CDPSession, Page, Request } from "playwright-core";
import { isJsonType } from "./data.js";

// A response one of the pod's pages received from a fetch or XHR. Only JSON
// bodies are kept, parsed, and only up to MAX_BODY characters.
export type Captured = {
  id: number;
  page: Page;
  method: string;
  url: string;
  status: number;
  contentType: string;
  json?: unknown;
  chars?: number;
  skipped?: string;
};
const MAX_CAPTURED = 150;
const MAX_BODY = 2_000_000;
// Bodies stay parsed in memory, so the oldest give theirs up past this total.
const MAX_BODIES = 16_000_000;

export class NetworkLog {
  readonly entries: Captured[] = [];
  private nextId = 1;

  async add(page: Page, req: Request): Promise<void> {
    const res = await req.response().catch(() => null);
    if (!res) return;
    const contentType = (await res.headerValue("content-type").catch(() => null)) ?? "";
    const entry: Captured = { id: this.nextId++, page, method: req.method(), url: req.url(), status: res.status(), contentType };
    if (!isJsonType(contentType)) entry.skipped = "not JSON";
    else {
      const body = await res.text().catch(() => undefined);
      if (body === undefined) entry.skipped = "body unavailable";
      else if (body.length > MAX_BODY) entry.skipped = `too large (${body.length} chars)`;
      else {
        try {
          entry.json = JSON.parse(body);
          entry.chars = body.length;
        } catch {
          entry.skipped = "invalid JSON";
        }
      }
    }
    this.entries.push(entry);
    if (this.entries.length > MAX_CAPTURED) this.entries.shift();
    let total = this.entries.reduce((sum, c) => sum + (c.json !== undefined ? c.chars ?? 0 : 0), 0);
    for (const old of this.entries) {
      if (total <= MAX_BODIES || old === entry) break;
      if (old.json === undefined) continue;
      total -= old.chars ?? 0;
      old.json = undefined;
      old.skipped = "dropped to save memory; open the page again";
    }
  }
}

export type LogEntry = { page: Page; level: string; text: string };
const MAX_LOGS = 200;
const MAX_LOG_CHARS = 500;

export class ConsoleLog {
  readonly entries: LogEntry[] = [];

  add(page: Page, level: string, text: string): void {
    this.entries.push({ page, level, text: text.slice(0, MAX_LOG_CHARS) });
    if (this.entries.length > MAX_LOGS) this.entries.shift();
  }
}

// Chrome reports downloads on the page's own session, so nothing here touches
// the station's download settings or sees other windows' files.
export function watchDownloads(session: CDPSession, note: (message: string) => void): void {
  const names = new Map<string, string>();
  session.on("Page.downloadWillBegin", ({ guid, suggestedFilename }) => {
    names.set(guid, suggestedFilename);
    note(`download started: ${suggestedFilename}`);
  });
  session.on("Page.downloadProgress", ({ guid, state }) => {
    if (state === "inProgress") return;
    note(`download ${state === "completed" ? "finished, in the station's download folder" : "canceled"}: ${names.get(guid) ?? guid}`);
    names.delete(guid);
  });
  void session.send("Page.enable").catch(() => {});
}
