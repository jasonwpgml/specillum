# Contributing to Specillum

Thanks for helping. Issues, ideas and pull requests are all welcome.

## Development

```bash
npm install
npm run build
npm test        # builds, then runs the tests that need no internet or windows
```

Tests launch their own headless Chrome with a temporary profile, so they never touch your real station. `npm run test:modes` opens real windows, `test:data` and `test:live` need the internet, and `SPECILLUM_HEADLESS=0` lets you watch any of them.

## Layout

| File | What it does |
|---|---|
| `src/station.ts` | Finds and launches the shared Chrome (the station) with a dedicated profile and a localhost debugging port |
| `src/pod.ts` | One agent's private window; only hands out pages it opened |
| `src/records.ts` | What a pod's pages did: responses, console messages, downloads |
| `src/allowlist.ts` | `SPECILLUM_ALLOWED_DOMAINS` and the checks behind it |
| `src/snapshot.ts` | In-page code for the compact snapshot (refs like `[e12]`) and text reading |
| `src/pageview.ts` | Snapshots across frames, refs back to elements, and what changed since the last look |
| `src/session.ts` | What every tool shares: the pod, the page view, and how an action reports back |
| `src/actions.ts` | Page actions that tools and recipes both perform |
| `src/recipes.ts` | Saved recipes: step format, validation, files on disk |
| `src/tools/` | MCP tools, one file per area. `index.ts` puts them in groups |
| `src/server.ts` | Starts the server and registers the tools |
| `src/cli.ts` | `specillum`, `specillum open`, `specillum help` |

## Adding a tool

Register it in the file of its area under `src/tools/`. If most agents will not need it, or it widens what an agent can reach, give it a group of its own in `src/tools/index.ts`, so it costs nothing for agents that leave it out. Actions end with `session.after(...)`, take `snapshot: snapshotFlag`, and data from a page is marked with `UNTRUSTED`.

## Pull requests

- Keep tools few and their output short: every line costs the agent tokens.
- Never add a tool that can list or reach pages outside the agent's own pod.
- Run `npm test` before opening a PR.

By contributing you agree that your contribution is licensed under the Apache License 2.0, the same as the project.
