// Page actions that tools and recipes both perform.
import type { Locator } from "playwright-core";
import { blockerInPage } from "./snapshot.js";

// Waiting out the full timeout behind a cookie banner tells the agent nothing,
// so a click that cannot land soon says what is in the way. The trial never
// clicks, so nothing is pressed twice.
export async function clickOn(loc: Locator, what: string, options: { button?: "left" | "right" | "middle"; double?: boolean } = {}): Promise<void> {
  const { double, button } = options;
  await loc.click({ trial: true, button, timeout: 4000 }).catch(async () => {
    await loc.scrollIntoViewIfNeeded({ timeout: 1000 }).catch(() => {});
    const blocker = await loc.evaluate(blockerInPage).catch(() => null);
    if (blocker) throw new Error(`Cannot click ${what}: it is covered by ${blocker}. Deal with that first, then click again.`);
  });
  if (double) await loc.dblclick({ button, timeout: 10_000 });
  else await loc.click({ button, timeout: 10_000 });
}
