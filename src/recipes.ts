// A recipe is a saved series of browser steps for one site, so an agent can
// repeat a task without reading the page again. Steps find elements by the role
// and name the snapshot shows, which survives layout changes that would break
// remembered coordinates. Recipes are shared by every pod of this station.
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { profileDir } from "./station.js";

const target = {
  role: z.string().describe('Role as the snapshot prints it, e.g. button, link, textbox, "textbox:search".'),
  name: z.string().describe("Name as the snapshot prints it."),
  contains: z.boolean().optional().describe("Match names containing this text. Default is an exact match."),
  nth: z.number().int().min(0).optional().describe("Which match to use when several fit. Without it, several matches fail the run."),
};

export const stepSchema = z.discriminatedUnion("do", [
  z.object({ do: z.literal("goto"), url: z.string().describe("Absolute URL on the recipe's site. Parameters are URL-encoded here.") }),
  z.object({ do: z.literal("click"), ...target }),
  z.object({ do: z.literal("type"), ...target, text: z.string(), submit: z.boolean().optional().describe("Press Enter after typing.") }),
  z.object({ do: z.literal("press"), key: z.string() }),
  z.object({
    do: z.literal("expect"),
    text: z.string().describe("Text that must appear on the page or in an iframe, or the run stops here."),
    seconds: z.number().min(0).max(60).optional().describe("Default 10."),
  }),
  z.object({
    do: z.literal("click_at"),
    x: z.number().min(0),
    y: z.number().min(0),
  }).describe("Last resort for what has no element, such as a map canvas. Must be followed by expect, and only runs at the viewport size it was saved with."),
]);
export type Step = z.infer<typeof stepSchema>;

const recipeSchema = z.object({
  name: z.string(),
  site: z.string(),
  description: z.string().optional(),
  params: z.array(z.string()),
  viewport: z.object({ width: z.number(), height: z.number() }).optional(),
  steps: z.array(stepSchema),
});
export type Recipe = z.infer<typeof recipeSchema>;

const NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const SITE = /^[a-z0-9.-]+$/;
const PLACEHOLDER = /\{([A-Za-z_]\w*)\}/g;

const recipesDir = () => process.env.SPECILLUM_RECIPES ?? join(dirname(profileDir()), "recipes");
const fileOf = (name: string) => {
  if (!NAME.test(name)) throw new Error(`Recipe name must match ${NAME}: ${name}`);
  return join(recipesDir(), `${name}.json`);
};

const textsOf = (step: Step) => Object.values(step).filter((v): v is string => typeof v === "string");

export function validateRecipe(recipe: Recipe): void {
  fileOf(recipe.name);
  if (!SITE.test(recipe.site)) throw new Error(`site must be a bare host such as map.naver.com: ${recipe.site}`);
  if (recipe.steps.length === 0) throw new Error("A recipe needs at least one step.");
  const used = new Set(recipe.steps.flatMap((s) => textsOf(s).flatMap((t) => [...t.matchAll(PLACEHOLDER)].map((m) => m[1]))));
  for (const p of used) if (!recipe.params.includes(p)) throw new Error(`{${p}} is used in a step but not listed in params.`);
  for (const p of recipe.params) if (!used.has(p)) throw new Error(`Parameter ${p} is not used by any step.`);
  recipe.steps.forEach((s, i) => {
    if (s.do === "type" && s.role === "textbox:password") throw new Error("Recipes never type into password fields; ask the user to log in.");
    if (s.do === "click_at" && recipe.steps[i + 1]?.do !== "expect") throw new Error(`Step ${i + 1}: click_at must be followed by expect, so a miss stops the run.`);
  });
}

export function saveRecipe(recipe: Recipe): void {
  const file = fileOf(recipe.name);
  mkdirSync(recipesDir(), { recursive: true });
  // Written whole, so another pod never reads half a recipe.
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(recipe, null, 2));
  renameSync(tmp, file);
}

export function loadRecipe(name: string): Recipe {
  const file = fileOf(name);
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    throw new Error(`No recipe named ${name}. Use recipe with action list.`);
  }
  return recipeSchema.parse(JSON.parse(raw));
}

export function listRecipes(): Recipe[] {
  let files: string[];
  try {
    files = readdirSync(recipesDir());
  } catch {
    return [];
  }
  return files.filter((f) => f.endsWith(".json")).map((f) => loadRecipe(f.slice(0, -5)));
}

export function deleteRecipe(name: string): void {
  loadRecipe(name);
  rmSync(fileOf(name));
}

// One pass over each string, so a value containing {other} is not expanded again.
export function fillStep(step: Step, values: Record<string, string>): Step {
  const fill = (s: string, encode: boolean) =>
    s.replace(PLACEHOLDER, (_, p: string) => (encode ? encodeURIComponent(values[p]!) : values[p]!));
  const out: Record<string, unknown> = { ...step };
  for (const [k, v] of Object.entries(step)) if (typeof v === "string") out[k] = fill(v, step.do === "goto");
  return out as Step;
}
