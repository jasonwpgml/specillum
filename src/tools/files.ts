// Sending local files to a website. Its own group, so an agent that has no
// need for it never holds it.
import { realpathSync, statSync } from "node:fs";
import { basename, delimiter, isAbsolute, relative, resolve, sep } from "node:path";
import type { Locator } from "playwright-core";
import { z } from "zod";
import { clickOn } from "../actions.js";
import { snapshotFlag } from "../session.js";
import type { Register } from "./index.js";

// A web page could ask for any file the agent can name, so uploads only come
// from the directory the agent runs in and any the user added. Links are
// resolved first, so one cannot point out of those directories.
function uploadFile(path: string): string {
  const roots = [process.cwd(), ...(process.env.SPECILLUM_UPLOAD_DIRS?.split(delimiter).filter(Boolean) ?? [])];
  let real: string;
  try {
    real = realpathSync(resolve(path));
  } catch {
    throw new Error(`No such file: ${path}`);
  }
  const inside = roots.some((root) => {
    const rel = relative(realpathSync(root), real);
    return rel && !rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel);
  });
  if (!inside) throw new Error(`${path} is outside the directories uploads may come from: ${roots.join(", ")}. The user can add one with SPECILLUM_UPLOAD_DIRS.`);
  if (!statSync(real).isFile()) throw new Error(`Not a file: ${path}`);
  return real;
}

export const registerFileTools: Register = (server, session) => {
  server.registerTool(
    "upload",
    {
      description:
        "Attach local files to a file input. Give the ref of the input or of the button that opens the file picker; without a ref, the page's only file input is used, even a hidden one. Files must be inside the directory the agent runs in or one the user added.",
      inputSchema: {
        paths: z.array(z.string()).min(1).describe("File paths."),
        ref: z.string().optional(),
        snapshot: snapshotFlag,
      },
    },
    async ({ paths, ref, snapshot: s }) => {
      const files = paths.map(uploadFile);
      const names = files.map((f) => basename(f)).join(", ");
      if (ref) {
        const { p, loc } = await session.locate(ref);
        const isInput = await loc.evaluate((el) => el instanceof HTMLInputElement && el.type === "file");
        if (isInput) await loc.setInputFiles(files, { timeout: 10_000 });
        else {
          const chooser = p.waitForEvent("filechooser", { timeout: 5000 });
          await clickOn(loc, ref);
          const opened = await chooser.catch(() => {
            throw new Error(`Clicking ${ref} did not open a file picker.`);
          });
          await opened.setFiles(files, { timeout: 10_000 });
        }
        return session.after(`uploaded ${names} through ${ref}`, s);
      }
      const inputs: Locator[] = [];
      for (const frame of (await session.page()).frames()) {
        const found = frame.locator("input[type=file]");
        for (let i = 0; i < (await found.count().catch(() => 0)); i++) inputs.push(found.nth(i));
      }
      if (inputs.length !== 1) throw new Error(`This page has ${inputs.length} file inputs. Give the ref of the input or of the button that opens the file picker.`);
      await inputs[0]!.setInputFiles(files, { timeout: 10_000 });
      return session.after(`uploaded ${names}`, s);
    },
  );
};
