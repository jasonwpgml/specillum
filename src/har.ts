// A record of what a pod's pages requested, in the HAR format browser dev tools
// read. It goes to a file the agent can upload or share, so it keeps no bodies,
// and secret-looking headers and query parameters are masked.
import type { Request } from "playwright-core";
import { redactUrl, redactValue } from "./data.js";

const MAX_ENTRIES = 5000;

const nameValues = (headers: Record<string, string>) => Object.entries(redactValue(headers) as Record<string, string>).map(([name, value]) => ({ name, value }));

async function toEntry(req: Request, error?: string): Promise<unknown> {
  const res = await req.response().catch(() => null);
  const sizes = res ? await req.sizes().catch(() => undefined) : undefined;
  const { startTime, responseStart, responseEnd } = req.timing();
  const url = redactUrl(req.url());
  // Timings are -1 when the request never got that far.
  const wait = Math.max(responseStart, 0);
  const receive = Math.max(responseEnd - wait, 0);
  return {
    startedDateTime: new Date(startTime).toISOString(),
    time: wait + receive,
    request: {
      method: req.method(),
      url,
      httpVersion: "HTTP/1.1",
      cookies: [],
      headers: nameValues(await req.allHeaders().catch(() => req.headers())),
      queryString: [...new URL(url).searchParams].map(([name, value]) => ({ name, value })),
      headersSize: sizes?.requestHeadersSize ?? -1,
      bodySize: sizes?.requestBodySize ?? -1,
    },
    response: {
      status: res?.status() ?? 0,
      statusText: res?.statusText() ?? error ?? "",
      httpVersion: "HTTP/1.1",
      cookies: [],
      headers: nameValues((await res?.allHeaders().catch(() => undefined)) ?? {}),
      content: { size: sizes?.responseBodySize ?? 0, mimeType: (await res?.headerValue("content-type").catch(() => null)) ?? "" },
      redirectURL: "",
      headersSize: sizes?.responseHeadersSize ?? -1,
      bodySize: sizes?.responseBodySize ?? -1,
    },
    cache: {},
    timings: { send: 0, wait, receive },
  };
}

export class HarRecorder {
  private readonly entries: Promise<unknown>[] = [];
  dropped = 0;

  constructor(readonly path: string) {}

  add(req: Request, error?: string): void {
    if (this.entries.length >= MAX_ENTRIES) this.dropped++;
    else this.entries.push(toEntry(req, error).catch(() => undefined));
  }

  async finish(): Promise<{ json: string; count: number }> {
    const entries = (await Promise.all(this.entries)).filter(Boolean);
    return { json: JSON.stringify({ log: { version: "1.2", creator: { name: "specillum", version: "0" }, entries } }, null, 1), count: entries.length };
  }
}
