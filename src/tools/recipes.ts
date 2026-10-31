// The recipe tool and the code that plays a recipe's steps. Step formats and
// files on disk are in ../recipes.ts.
import type { Page } from "playwright-core";
import { z } from "zod";
import { clickOn } from "../actions.js";
import { onSite } from "../allowlist.js";
import { redactUrl } from "../data.js";
import type { Pod } from "../pod.js";
import { deleteRecipe, fillStep, listRecipes, loadRecipe, saveRecipe, stepSchema, validateRecipe, type Recipe, type Step } from "../recipes.js";
import { snapshotFlag, text, type Session } from "../session.js";
import type { Register } from "./index.js";

// Finds a recipe step's element by what the snapshot shows, in any frame,
// waiting for it to render. Several matches fail rather than guess.
const findElement = async (session: Session, p: Page, t: { role: string; name: string; contains?: boolean; nth?: number }) => {
  const wanted = `${t.role} "${t.name}"`;
  const deadline = Date.now() + 10_000;
  while (true) {
    // A navigation can destroy the page's context while it is being read.
    const items = await session.pages.read(p, 1000).then((s) => s.items, () => []);
    const hits = items.filter((i) => i.role === t.role && (t.contains ? i.name.includes(t.name) : i.name === t.name));
    if (hits.length > 1 && t.nth === undefined) {
      throw new Error(`${hits.length} elements match ${wanted}: ${hits.slice(0, 5).map((h) => `"${h.name}"`).join(", ")}. Set nth or a more exact name.`);
    }
    const hit = hits[t.nth ?? 0];
    if (hit) return session.pages.locate(p, hit.ref);
    if (Date.now() > deadline) throw new Error(`No element matches ${wanted}.`);
    await p.waitForTimeout(300);
  }
};

const waitForText = async (p: Page, needle: string, seconds: number) => {
  const deadline = Date.now() + seconds * 1000;
  while (true) {
    for (const frame of p.frames()) {
      if (await frame.getByText(needle).first().isVisible().catch(() => false)) return;
    }
    if (Date.now() > deadline) throw new Error(`Expected text did not appear within ${seconds}s: "${needle}".`);
    await p.waitForTimeout(300);
  }
};

const viewportOf = (p: Page) => p.evaluate(() => ({ width: innerWidth, height: innerHeight }));

// Right after a navigation Chrome can drop a raw mouse press while still
// delivering moves. A press the page never saw did nothing, so it is safe to
// repeat. Locator clicks wait for this on their own; a bare mouse click does
// not. An iframe's presses never report here, so those get one attempt and
// the recipe's expect step catches a miss.
const clickAt = async (p: Page, x: number, y: number) => {
  const FLAG = "__specillumPressed";
  const overFrame = await p.evaluate(([px, py]) => document.elementFromPoint(px!, py!)?.tagName === "IFRAME", [x, y]);
  for (let i = 0; i < 10; i++) {
    await p.evaluate((flag) => {
      const w = window as unknown as Record<string, boolean>;
      w[flag] = false;
      addEventListener("mousedown", () => (w[flag] = true), { once: true, capture: true });
    }, FLAG);
    await p.mouse.click(x, y);
    // A click that navigates destroys the page it would be read from.
    const pressed = await p.evaluate((flag) => (window as unknown as Record<string, boolean>)[flag], FLAG).catch(() => true);
    if (overFrame || pressed) return;
    await p.waitForTimeout(300);
  }
  throw new Error(`The page never received the click at ${x},${y}.`);
};

const runStep = async (session: Session, pd: Pod, recipe: Recipe, step: Step) => {
  const p = await pd.page();
  const t0 = Date.now();
  if (step.do === "goto") {
    if (!onSite(step.url, recipe.site)) throw new Error(`goto leaves the recipe's site ${recipe.site}: ${redactUrl(step.url)}`);
    await p.goto(step.url, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await pd.settle(0, t0);
    return;
  }
  // A redirect may have landed on another site, or a login page elsewhere.
  if (!onSite(p.url(), recipe.site)) throw new Error(`The tab is not on the recipe's site ${recipe.site}.`);
  switch (step.do) {
    case "click":
      await clickOn(await findElement(session, p, step), `${step.role} "${step.name}"`);
      break;
    case "type": {
      const loc = await findElement(session, p, step);
      if ((await loc.getAttribute("type")) === "password") throw new Error("Recipes never type into password fields; ask the user to log in.");
      await loc.fill(step.text, { timeout: 10_000 });
      if (step.submit) await loc.press("Enter");
      break;
    }
    case "press":
      await p.keyboard.press(step.key);
      break;
    case "expect":
      await waitForText(p, step.text, step.seconds ?? 10);
      return;
    case "click_at": {
      const now = await viewportOf(p);
      const saved = recipe.viewport;
      if (!saved || saved.width !== now.width || saved.height !== now.height) {
        throw new Error(`click_at was saved for a ${saved?.width}x${saved?.height} viewport; this tab is ${now.width}x${now.height}. Save the recipe again at this size.`);
      }
      await clickAt(p, step.x, step.y);
      break;
    }
  }
  await pd.settle(100);
};

const describeRecipe = (r: Recipe) => {
  const params = r.params.length ? ` (${r.params.join(", ")})` : "";
  return `${r.name}${params} on ${r.site}, ${r.steps.length} steps${r.description ? ` — ${r.description}` : ""}`;
};

export const registerRecipeTools: Register = (server, session) => {
  server.registerTool(
    "recipe",
    {
      description:
        "Save and replay a series of steps for one site, so a repeated task does not need the page read again. Before doing a task by hand, list recipes for the site. After finishing a task you will repeat, save it, using the role and name the snapshot printed, with {param} placeholders for what changes, and end with an expect step. If a run fails, it stops at that step and returns a snapshot: fix the steps and save again under the same name. Never put passwords or other secrets in steps.",
      inputSchema: {
        action: z.enum(["list", "show", "save", "run", "delete"]),
        name: z.string().optional().describe("Recipe name: lowercase letters, digits, - and _. Required except for list."),
        site: z.string().optional().describe("save: host the recipe may act on, including its subdomains, e.g. naver.com. list: only recipes for this host."),
        description: z.string().optional().describe("save: what the recipe does."),
        params: z.array(z.string()).optional().describe("save: names of the {placeholders} the steps use."),
        steps: z.array(stepSchema).optional().describe("save: the steps, in order."),
        values: z.record(z.string(), z.string()).optional().describe("run: a value for every parameter."),
        snapshot: snapshotFlag,
      },
    },
    async ({ action, name, site, description, params, steps, values, snapshot: s }) => {
      if (action === "list") {
        const all = listRecipes().filter((r) => !site || r.site === site || site.endsWith(`.${r.site}`));
        return text(all.length ? all.map(describeRecipe).join("\n") : "No recipes saved yet.");
      }
      if (!name) throw new Error(`recipe ${action} needs a name.`);
      if (action === "show") return text(JSON.stringify(loadRecipe(name), null, 2));
      if (action === "delete") {
        deleteRecipe(name);
        return text(`deleted recipe ${name}`);
      }
      if (action === "save") {
        if (!site || !steps) throw new Error("recipe save needs site and steps.");
        const recipe: Recipe = { name, site, description, params: params ?? [], steps };
        validateRecipe(recipe);
        if (steps.some((step) => step.do === "click_at")) recipe.viewport = await viewportOf(await session.page());
        saveRecipe(recipe);
        return text(`saved recipe ${describeRecipe(recipe)}`);
      }

      const recipe = loadRecipe(name);
      const missing = recipe.params.filter((p) => values?.[p] === undefined);
      if (missing.length) throw new Error(`recipe ${name} needs values for: ${missing.join(", ")}`);
      const pd = await session.getPod();
      for (const [i, step] of recipe.steps.entries()) {
        try {
          await runStep(session, pd, recipe, fillStep(step, values ?? {}));
        } catch (err) {
          const p = await pd.page();
          const state = await session.pages.snapshot(p).catch(() => `url: ${p.url()}`);
          // The saved step, not the filled one, so values stay out of the report.
          throw new Error(
            `recipe ${name} stopped at step ${i + 1}/${recipe.steps.length}: ${JSON.stringify(step)}\nreason: ${(err as Error).message}\nThe page is left as it is:\n${state}`,
          );
        }
      }
      return session.after(`ran recipe ${name}: ${recipe.steps.length} steps`, s, 0);
    },
  );
};
