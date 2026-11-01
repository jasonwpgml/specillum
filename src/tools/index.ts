// Tools come in groups, so a new one only costs tokens for agents that want it.
// To add a tool, register it in a group's file; to add a group, list it here.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Session } from "../session.js";
import { registerDataTools } from "./data.js";
import { registerDebugTools } from "./debug.js";
import { registerFileTools } from "./files.js";
import { registerInteractTools } from "./interact.js";
import { registerNavigationTools } from "./navigation.js";
import { registerPageTools } from "./page.js";
import { registerPodTools } from "./pod.js";
import { registerRecipeTools } from "./recipes.js";
import { registerStorageTools } from "./storage.js";

export type Register = (server: McpServer, session: Session) => void;

const GROUPS: Record<string, Register[]> = {
  core: [registerPodTools, registerNavigationTools, registerPageTools, registerInteractTools],
  files: [registerFileTools],
  data: [registerDataTools],
  debug: [registerDebugTools],
  recipes: [registerRecipeTools],
  storage: [registerStorageTools],
};

// Groups that reach the user's logins, so an agent only has them if asked for.
const BY_NAME_ONLY = new Set(["storage"]);

// SPECILLUM_TOOLS lists the groups to add to core. Unset means all but those above.
export function registerTools(server: McpServer, session: Session): void {
  const chosen = process.env.SPECILLUM_TOOLS?.split(",").map((g) => g.trim()).filter(Boolean) ?? Object.keys(GROUPS).filter((g) => !BY_NAME_ONLY.has(g));
  const unknown = chosen.filter((g) => !GROUPS[g]);
  if (unknown.length) throw new Error(`SPECILLUM_TOOLS has unknown groups: ${unknown.join(", ")}. Groups: ${Object.keys(GROUPS).join(", ")}`);
  for (const group of new Set(["core", ...chosen])) {
    for (const register of GROUPS[group]!) register(server, session);
  }
}
