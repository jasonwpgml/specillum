// How one agent reads its tabs: snapshots across frames, refs back to elements,
// and what the agent last saw of each tab.
import type { Frame, Locator, Page } from "playwright-core";
import { UNTRUSTED } from "./data.js";
import { REF_ATTR, snapshotInPage, type SnapshotItem } from "./snapshot.js";

export type PageRead = { meta: string; doc: string; lines: string[]; items: SnapshotItem[]; hidden: number };

const REF_LINE = /^\[(\S+?)\]/;

export class PageView {
  // Every frame a snapshot has numbered, so refs like f2e5 resolve to frame 2. A
  // frame keeps its number, which keeps the refs inside it stable. 0 is unused.
  private readonly frames: (Frame | undefined)[] = [undefined];
  private readonly lastRefs = new WeakMap<Frame, number>();
  // What the agent last saw of each tab, to answer "what changed?". Snapshots a
  // recipe takes for itself do not count, since the agent never saw them.
  private readonly seen = new WeakMap<Page, { doc: string; maxElements: number; meta: string; lines: Map<string, string> }>();

  async locate(p: Page, ref: string): Promise<Locator> {
    const m = /^f(\d+)e\d+$/.exec(ref);
    const index = m ? Number(m[1]) : 0;
    const frame = m ? this.frames[index] : p.mainFrame();
    if (!frame || frame.isDetached() || frame.page() !== p) {
      if (frame?.isDetached()) this.frames[index] = undefined;
      throw new Error(`Ref ${ref} belongs to a frame that is gone. Call snapshot again.`);
    }
    const loc = frame.locator(`[${REF_ATTR}="${ref}"]`);
    if ((await loc.count()) === 0) throw new Error(`Ref ${ref} not found. The page changed; call snapshot again.`);
    return loc.first();
  }

  private async readFrame(frame: Frame, maxElements: number, prefix: string, meta: boolean) {
    const s = await frame.evaluate(snapshotInPage, { maxElements, refAttr: REF_ATTR, prefix, meta, firstRef: this.lastRefs.get(frame) ?? 0 });
    this.lastRefs.set(frame, s.lastRef);
    return s;
  }

  // Snapshots the main frame plus every visible iframe (same- or cross-origin).
  async read(p: Page, maxElements: number): Promise<PageRead> {
    const main = await this.readFrame(p.mainFrame(), maxElements, "e", true);
    const lines = [...main.lines];
    const items = [...main.items];
    let hidden = main.hidden;
    // Ad-heavy pages carry dozens of iframes, and a frame that is navigating never
    // answers, so they are read together and a slow one is left out. A main frame
    // that used up the limit leaves no room for them, so they are not read at all.
    const frames = lines.length < maxElements ? p.frames().slice(1) : [];
    const subs = await Promise.all(frames.map(async (frame) => {
      const box = await frame.frameElement().then((el) => el.boundingBox()).catch(() => null);
      if (!box || box.width < 2 || box.height < 2) return null;
      const known = this.frames.indexOf(frame);
      const index = known > 0 ? known : this.frames.push(frame) - 1;
      const sub = await Promise.race([
        this.readFrame(frame, maxElements, `f${index}e`, false).catch(() => null),
        new Promise<null>((r) => setTimeout(r, 2000, null)),
      ]);
      return sub && { index, frame, sub };
    }));
    for (const found of subs) {
      if (!found || found.sub.lines.length === 0) continue;
      const { index, frame, sub } = found;
      const budget = maxElements - lines.length;
      hidden += sub.hidden + Math.max(0, sub.lines.length - Math.max(0, budget));
      if (budget <= 0) continue;
      lines.push(`-- iframe f${index}: ${frame.url().slice(0, 100)}`, ...sub.lines.slice(0, budget));
      items.push(...sub.items.slice(0, budget));
    }
    return { meta: main.meta, doc: main.doc, lines, items, hidden };
  }

  private full(s: PageRead, lines = s.lines): string {
    const more = s.hidden > 0 ? `\n(${s.hidden} more elements not shown; raise maxElements or scroll)` : "";
    return `${UNTRUSTED}\n${s.meta}\nelements:\n${lines.join("\n")}${more}`;
  }

  async snapshot(p: Page, maxElements = 150): Promise<string> {
    return this.full(await this.read(p, maxElements));
  }

  async view(p: Page, opts: { maxElements?: number; match?: string; changes?: boolean } = {}): Promise<string> {
    if (opts.match) {
      const s = await this.read(p, opts.maxElements ?? 1000);
      const needle = opts.match.toLowerCase();
      const hits = s.lines.filter((l) => REF_LINE.test(l) && l.toLowerCase().includes(needle));
      return `${this.full(s, hits)}\n(${hits.length} elements match "${opts.match}")`;
    }
    const maxElements = opts.maxElements ?? 150;
    const s = await this.read(p, maxElements);
    const lines = new Map(s.lines.flatMap((l): [string, string][] => {
      const ref = REF_LINE.exec(l)?.[1];
      return ref ? [[ref, l]] : [];
    }));
    const before = this.seen.get(p);
    this.seen.set(p, { doc: s.doc, maxElements, meta: s.meta, lines });
    const full = this.full(s);
    if (!opts.changes || !before || before.doc !== s.doc || before.maxElements !== maxElements) return full;
    const diff = [
      ...[...lines].filter(([ref]) => !before.lines.has(ref)).map(([, l]) => `+ ${l}`),
      ...[...lines].filter(([ref, l]) => before.lines.has(ref) && before.lines.get(ref) !== l).map(([, l]) => `~ ${l}`),
      ...[...before.lines].filter(([ref]) => !lines.has(ref)).map(([, l]) => `- ${l}`),
    ];
    if (!diff.length && before.meta === s.meta) return "unchanged since the last snapshot";
    const delta = `${UNTRUSTED}\n${s.meta}\nchanges since the last snapshot (+ new, ~ changed, - gone or past the element limit):\n${diff.join("\n") || "none in the elements"}`;
    return delta.length < full.length ? delta : full;
  }
}
