# Contributing to Specillum

Thanks for helping. Issues, ideas and pull requests are all welcome.

## Development

```bash
npm install
npm run build
npm run smoke   # two agents, isolation and cleanup, on a throwaway profile
```

The smoke test launches its own Chrome on port 9444 with a temporary profile, so it never touches your real station.

## Layout

| File | What it does |
|---|---|
| `src/station.ts` | Finds and launches the shared Chrome (the station) with a dedicated profile and a localhost debugging port |
| `src/pod.ts` | One agent's private window; only hands out pages it opened |
| `src/snapshot.ts` | In-page code for the compact snapshot (refs like `[e12]`) and text reading |
| `src/server.ts` | MCP tools |
| `src/cli.ts` | `specillum`, `specillum open`, `specillum help` |

## Pull requests

- Keep tools few and their output short: every line costs the agent tokens.
- Never add a tool that can list or reach pages outside the agent's own pod.
- Run `npm run smoke` before opening a PR.

By contributing you agree that your contribution is licensed under the Apache License 2.0, the same as the project.
