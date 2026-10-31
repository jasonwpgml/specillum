// Compact, token-friendly page snapshot. Runs inside the page: it tags every
// visible interactive element with a short ref (e1, e2, ...) that the action
// tools resolve later, and returns one line per element. An element keeps its
// ref for as long as it stays in the document, so two snapshots can be compared.
//
// Everything below must stay self-contained because Playwright serializes the
// function into the page.

export const REF_ATTR = "data-specillum-ref";

export type SnapshotItem = { ref: string; role: string; name: string };
export type FrameSnapshot = { meta: string; lines: string[]; items: SnapshotItem[]; hidden: number; doc: string };

// prefix makes refs unique across frames: "e" in the main frame, "f2e" in frame 2.
export function snapshotInPage(args: { maxElements: number; refAttr: string; prefix: string; meta: boolean }): FrameSnapshot {
  const { maxElements, refAttr, prefix } = args;
  // Numbers are never reused within a document, and doc tells a reload apart.
  const w = window as unknown as { __specillum?: { next: number; doc: string } };
  const state = (w.__specillum ??= { next: 0, doc: Math.random().toString(36).slice(2) });
  const SELECTOR = [
    "a[href]", "button", "input:not([type=hidden])", "select", "textarea", "summary",
    "[role=button]", "[role=link]", "[role=checkbox]", "[role=radio]", "[role=tab]",
    "[role=menuitem]", "[role=option]", "[role=switch]", "[role=combobox]",
    "[role=textbox]", "[role=searchbox]", "[contenteditable=''], [contenteditable=true]",
  ].join(",");

  const clean = (s: string | null | undefined, max = 80) => {
    const t = (s ?? "").replace(/\s+/g, " ").trim();
    return t.length > max ? t.slice(0, max - 1) + "…" : t;
  };

  const visible = (el: Element) => {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return false;
    const st = getComputedStyle(el);
    return st.visibility !== "hidden" && st.display !== "none" && Number(st.opacity) > 0;
  };

  const inViewport = (el: Element) => {
    const r = el.getBoundingClientRect();
    return r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth;
  };

  const nameOf = (el: Element): string => {
    const aria = el.getAttribute("aria-label");
    if (aria) return clean(aria);
    const by = el.getAttribute("aria-labelledby");
    if (by) {
      const t = by.split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? "").join(" ");
      if (clean(t)) return clean(t);
    }
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
      const label = el.labels?.[0]?.textContent;
      if (clean(label)) return clean(label);
      if ("placeholder" in el && el.placeholder) return clean(el.placeholder);
    }
    const text = clean((el as HTMLElement).innerText);
    if (text) return text;
    const img = el.querySelector("img[alt]");
    if (img) return clean(img.getAttribute("alt"));
    return clean(el.getAttribute("title") ?? el.getAttribute("name") ?? "");
  };

  const roleOf = (el: Element): string => {
    const role = el.getAttribute("role");
    if (role) return role;
    const tag = el.tagName.toLowerCase();
    if (tag === "a") return "link";
    if (tag === "select") return "combobox";
    if (tag === "textarea") return "textbox";
    if (tag === "input") {
      const type = (el as HTMLInputElement).type;
      if (["checkbox", "radio"].includes(type)) return type;
      if (["submit", "button", "reset", "image"].includes(type)) return "button";
      return type === "text" ? "textbox" : `textbox:${type}`;
    }
    if ((el as HTMLElement).isContentEditable) return "textbox";
    return tag;
  };

  // Collect through open shadow roots too.
  const found: Element[] = [];
  const walk = (root: Document | ShadowRoot) => {
    root.querySelectorAll(SELECTOR).forEach((el) => found.push(el));
    root.querySelectorAll("*").forEach((el) => {
      if (el.shadowRoot) walk(el.shadowRoot);
    });
  };
  walk(document);

  const candidates = found.filter(visible);
  // Elements on screen first, then the rest of the page in document order.
  const ordered = [...candidates.filter(inViewport), ...candidates.filter((el) => !inViewport(el))];
  const picked = ordered.slice(0, maxElements);

  const lines: string[] = [];
  const items: SnapshotItem[] = [];
  // A page that clones a tagged element copies its ref too; only one may keep it.
  const taken = new Set<string>();
  for (const el of picked) {
    const kept = el.getAttribute(refAttr);
    const ref = kept?.startsWith(prefix) && !taken.has(kept) ? kept : `${prefix}${++state.next}`;
    taken.add(ref);
    el.setAttribute(refAttr, ref);
    const role = roleOf(el);
    const name = nameOf(el);
    items.push({ ref, role, name });
    let line = `[${ref}] ${role} "${name}"`;
    if (el instanceof HTMLInputElement && (el.type === "checkbox" || el.type === "radio")) {
      line += el.checked ? " checked" : "";
    } else if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      if (el.value) line += ` value="${clean(el.type === "password" ? "••••" : el.value, 40)}"`;
    } else if (el instanceof HTMLSelectElement) {
      line += ` selected="${clean(el.selectedOptions[0]?.textContent, 40)}"`;
    } else if (el instanceof HTMLAnchorElement) {
      try {
        const u = new URL(el.href);
        line += ` -> ${u.origin === location.origin ? u.pathname + u.search : u.host + u.pathname}`;
      } catch {}
    }
    if ((el as HTMLElement).hasAttribute("disabled")) line += " disabled";
    if (!inViewport(el)) line += " (offscreen)";
    lines.push(line);
  }

  const hidden = candidates.length - picked.length;
  if (!args.meta) return { meta: "", lines, items, hidden, doc: state.doc };

  const headings = [...document.querySelectorAll("h1, h2, h3")]
    .filter(visible)
    .slice(0, 15)
    .map((h) => `${h.tagName.toLowerCase()}: ${clean(h.textContent, 100)}`);
  const scrollable = document.documentElement.scrollHeight - innerHeight;
  const scrolled = scrollable > 0 ? Math.round((scrollY / scrollable) * 100) : 100;
  const meta = [
    `title: ${document.title}`,
    `url: ${location.href.length > 200 ? location.href.slice(0, 199) + "…" : location.href}`,
    `scroll: ${scrolled}%`,
    headings.length ? `headings:\n${headings.map((h) => "  " + h).join("\n")}` : "",
  ]
    .filter(Boolean)
    .join("\n");
  return { meta, lines, items, hidden, doc: state.doc };
}

// Names what sits on top of an element's center, or null if nothing does.
export function blockerInPage(el: Element): string | null {
  const r = el.getBoundingClientRect();
  const x = r.left + r.width / 2;
  const y = r.top + r.height / 2;
  let top = document.elementFromPoint(x, y);
  while (top?.shadowRoot) {
    const inner = top.shadowRoot.elementFromPoint(x, y);
    if (!inner || inner === top) break;
    top = inner;
  }
  if (!top || top === el || el.contains(top)) return null;
  const id = top.id ? `#${top.id}` : "";
  const cls = typeof top.className === "string" && top.className.trim() ? `.${top.className.trim().split(/\s+/)[0]}` : "";
  const words = ((top as HTMLElement).innerText ?? "").replace(/\s+/g, " ").trim().slice(0, 60);
  return `<${top.tagName.toLowerCase()}${id}${cls}>${words ? ` "${words}"` : ""}`;
}

// Draws each ref over its element for a screenshot, or takes the labels away.
// Page geometry is used so the labels also line up in a full-page capture.
export function annotateInPage(args: { refAttr: string; on: boolean }): void {
  const ID = "__specillum-labels";
  document.getElementById(ID)?.remove();
  if (!args.on) return;
  const layer = document.createElement("div");
  layer.id = ID;
  layer.style.cssText = "position:absolute;left:0;top:0;width:0;height:0;z-index:2147483647;pointer-events:none";
  const walk = (root: Document | ShadowRoot) => {
    root.querySelectorAll(`[${args.refAttr}]`).forEach((el) => {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return;
      const label = document.createElement("div");
      label.textContent = el.getAttribute(args.refAttr);
      label.style.cssText = `position:absolute;left:${r.left + scrollX}px;top:${r.top + scrollY}px;font:bold 11px/13px monospace;padding:0 2px;color:#fff;background:#d00;white-space:nowrap`;
      layer.append(label);
    });
    root.querySelectorAll("*").forEach((el) => {
      if (el.shadowRoot) walk(el.shadowRoot);
    });
  };
  walk(document);
  document.documentElement.append(layer);
}

export function readInPage(args: { selector?: string; maxChars: number }): string {
  const root =
    (args.selector ? document.querySelector(args.selector) : null) ??
    document.querySelector("main, article, [role=main]") ??
    document.body;
  const text = ((root as HTMLElement)?.innerText ?? "").replace(/\n{3,}/g, "\n\n").trim();
  return text.length > args.maxChars ? text.slice(0, args.maxChars) + `\n…(${text.length - args.maxChars} more chars)` : text;
}
