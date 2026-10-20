// Compact, token-friendly page snapshot. Runs inside the page: it tags every
// visible interactive element with a short ref (e1, e2, ...) that the action
// tools resolve later, and returns one line per element.
//
// Everything below must stay self-contained because Playwright serializes the
// function into the page.

export const REF_ATTR = "data-specillum-ref";

export function snapshotInPage(args: { maxElements: number; refAttr: string }): string {
  const { maxElements, refAttr } = args;
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
  document.querySelectorAll(`[${refAttr}]`).forEach((el) => el.removeAttribute(refAttr));
  walk(document);

  const candidates = found.filter(visible);
  // Elements on screen first, then the rest of the page in document order.
  const ordered = [...candidates.filter(inViewport), ...candidates.filter((el) => !inViewport(el))];
  const picked = ordered.slice(0, maxElements);

  const lines: string[] = [];
  let n = 0;
  for (const el of picked) {
    const ref = `e${++n}`;
    el.setAttribute(refAttr, ref);
    const role = roleOf(el);
    let line = `[${ref}] ${role} "${nameOf(el)}"`;
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

  const headings = [...document.querySelectorAll("h1, h2, h3")]
    .filter(visible)
    .slice(0, 15)
    .map((h) => `${h.tagName.toLowerCase()}: ${clean(h.textContent, 100)}`);

  const scrollable = document.documentElement.scrollHeight - innerHeight;
  const scrolled = scrollable > 0 ? Math.round((scrollY / scrollable) * 100) : 100;
  const more = candidates.length > picked.length ? `\n(${candidates.length - picked.length} more elements not shown)` : "";

  return [
    `title: ${document.title}`,
    `url: ${location.href}`,
    `scroll: ${scrolled}%`,
    headings.length ? `headings:\n${headings.map((h) => "  " + h).join("\n")}` : "",
    `elements:\n${lines.join("\n")}${more}`,
  ]
    .filter(Boolean)
    .join("\n");
}

export function readInPage(args: { selector?: string; maxChars: number }): string {
  const root =
    (args.selector ? document.querySelector(args.selector) : null) ??
    document.querySelector("main, article, [role=main]") ??
    document.body;
  const text = ((root as HTMLElement)?.innerText ?? "").replace(/\n{3,}/g, "\n\n").trim();
  return text.length > args.maxChars ? text.slice(0, args.maxChars) + `\n…(${text.length - args.maxChars} more chars)` : text;
}
