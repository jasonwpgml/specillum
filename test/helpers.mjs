// What every test needs: a throwaway station that never touches your real one,
// agents connected to it, and checks that all run even if an earlier one fails.
// Stations run without windows unless a test needs them or SPECILLUM_HEADLESS=0.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const CLI = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

export function testStation(name, port, env = {}) {
  const profile = mkdtempSync(join(tmpdir(), `specillum-${name}-`));
  return { port, profile, env: { SPECILLUM_HEADLESS: "1", ...process.env, SPECILLUM_PORT: port, SPECILLUM_PROFILE: profile, ...env } };
}

export async function closeStation(station) {
  try {
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${station.port}`);
    await (await browser.newBrowserCDPSession()).send("Browser.close");
  } catch {}
  await new Promise((r) => setTimeout(r, 1500));
  rmSync(station.profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
}

export async function connectAgent(station, name, { env = {}, cwd } = {}) {
  const client = new Client({ name, version: "0.0.0" });
  await client.connect(new StdioClientTransport({ command: "node", args: [CLI], cwd, env: { ...station.env, ...env } }));
  const call = async (tool, args = {}) => {
    const res = await client.callTool({ name: tool, arguments: args });
    const out = res.content.map((c) => c.text ?? `[${c.type}:${c.data?.length ?? 0}]`).join("\n");
    if (res.isError) throw new Error(`${tool}: ${out}`);
    return out;
  };
  const fails = (tool, args) =>
    call(tool, args).then(
      (out) => {
        throw new Error(`${tool} should have failed:\n${out}`);
      },
      (e) => e.message,
    );
  return { client, call, fails };
}

export const expect = (cond, msg) => {
  if (!cond) throw new Error(msg);
};

let passed = 0;
let failed = 0;

export async function check(name, fn) {
  const t0 = Date.now();
  try {
    const detail = await fn();
    passed++;
    console.log(`PASS ${name} (${Date.now() - t0}ms)${detail ? " — " + detail : ""}`);
  } catch (e) {
    failed++;
    console.log(`FAIL ${name} (${Date.now() - t0}ms) — ${String(e.message ?? e).slice(0, 1500)}`);
  }
}

export function finish() {
  console.log(failed ? `\n${failed} FAILED, ${passed} passed` : `\nALL PASSED (${passed})`);
  process.exitCode = failed ? 1 : 0;
}
