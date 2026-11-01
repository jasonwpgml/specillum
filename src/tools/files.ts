// Sending local files to a website and saving pages to local files. Its own
// group, so an agent that has no need for it never holds it.
import { lstatSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { basename, delimiter, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Locator } from "playwright-core";
import { z } from "zod";
import { clickOn } from "../actions.js";
import { HarRecorder } from "../har.js";
import { snapshotFlag, text } from "../session.js";
import type { Register } from "./index.js";

// A web page could ask for any file the agent can name, so uploads only come
// from the directory the agent runs in and any the user added. Links are
// resolved first, so one cannot point out of those directories.
const uploadRoots = () => [process.cwd(), ...(process.env.SPECILLUM_UPLOAD_DIRS?.split(delimiter).filter(Boolean) ?? [])];

const insideRoots = (real: string, roots: string[]) =>
  roots.some((root) => {
    const rel = relative(realpathSync(root), real);
    return rel && !rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel);
  });

function uploadFile(path: string): string {
  const roots = uploadRoots();
  let real: string;
  try {
    real = realpathSync(resolve(path));
  } catch {
    throw new Error(`No such file: ${path}`);
  }
  if (!insideRoots(real, roots)) throw new Error(`${path} is outside the directories uploads may come from: ${roots.join(", ")}. The user can add one with SPECILLUM_UPLOAD_DIRS.`);
  if (!statSync(real).isFile()) throw new Error(`Not a file: ${path}`);
  return real;
}

// Files the tools write stay in the agent's directory too, and never replace
// anything: writing with "wx" also refuses a link left at the path.
function newFile(path: string, extension: string): string {
  if (extname(path).toLowerCase() !== extension) throw new Error(`The file name must end in ${extension}.`);
  const roots = [process.cwd()];
  let real: string;
  try {
    real = join(realpathSync(dirname(resolve(path))), basename(path));
  } catch {
    throw new Error(`No such directory: ${dirname(path)}`);
  }
  if (!insideRoots(real, roots)) throw new Error(`${path} is outside the directory the agent runs in: ${roots.join(", ")}.`);
  if (lstatSync(real, { throwIfNoEntry: false })) throw new Error(`${path} already exists.`);
  return real;
}

export const registerFileTools: Register = (server, session) => {
  server.registerTool(
    "pdf",
    {
      description: "Save the active tab as a PDF file. The file must be new and inside the directory the agent runs in.",
      inputSchema: {
        path: z.string().describe('File path, e.g. "page.pdf".'),
        landscape: z.boolean().optional(),
      },
    },
    async ({ path, landscape }) => {
      const file = newFile(path, ".pdf");
      const pdf = await (await session.page()).pdf({ landscape, printBackground: true });
      writeFileSync(file, pdf, { flag: "wx" });
      return text(`saved ${file} (${pdf.length} bytes)`);
    },
  );

  server.registerTool(
    "har",
    {
      description:
        "Record what this pod's tabs request to a HAR file, for reading in browser dev tools. Call start, use the page, then stop. No bodies are kept and secret-looking headers and query parameters are masked. The file must be new and inside the directory the agent runs in.",
      inputSchema: {
        action: z.enum(["start", "stop"]),
        path: z.string().optional().describe('Required for start, e.g. "trace.har".'),
      },
    },
    async ({ action, path }) => {
      const pd = await session.getPod();
      if (action === "start") {
        if (pd.har) throw new Error(`Already recording to ${pd.har.path}.`);
        if (!path) throw new Error("start needs path.");
        pd.har = new HarRecorder(newFile(path, ".har"));
        return text(`recording to ${pd.har.path}`);
      }
      if (!pd.har) throw new Error("Not recording. Call start first.");
      const recorder = pd.har;
      pd.har = undefined;
      const { json, count } = await recorder.finish();
      writeFileSync(recorder.path, json, { flag: "wx" });
      return text(`saved ${recorder.path} (${count} requests${recorder.dropped ? `, ${recorder.dropped} past the limit left out` : ""})`);
    },
  );

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
