# Specillum

**English** | [한국어](README.ko.md) | [日本語](README.ja.md) | [简体中文](README.zh-CN.md) | [Español](README.es.md)

**Isolated browser pods for AI agents, inside your own logged-in Chrome.**

Specillum is an open-source [MCP](https://modelcontextprotocol.io) server that lets AI agents such as **Claude Code**, **OpenAI Codex** and **Cursor** browse the web with your real logins, while giving **every agent its own private browser window (a "pod")**. Agents never see or touch your tabs, and they never step on each other.

*Specillum* is Latin for **probe**. From a single shared station, each agent goes out as its own probe.

[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![MCP](https://img.shields.io/badge/MCP-server-black.svg)](https://modelcontextprotocol.io)

> If Specillum is useful to you, please **star the repo**. It helps other people find it.

---

## Why

Most browser tools for agents give you one of two things:

- **A fresh headless browser** with no logins, so the agent hits sign-in walls everywhere.
- **Your real browser**, where every agent shares the same tabs. They interfere with each other and with you.

Specillum keeps both benefits:

| | Fresh browser (e.g. default Playwright MCP) | Your browser, shared | **Specillum** |
|---|---|---|---|
| Uses your live logins | No | Yes | **Yes** |
| Each agent has its own space | Yes | No | **Yes** |
| Agents can't reach your tabs | Yes | No | **Yes** |
| You can watch and take over | Headed only | Yes | **Yes** |
| Several agents at once | Separate browsers | Collisions | **One browser, one pod each** |

## How it works

```
                 ┌──────────────── Station: one real Chrome, dedicated profile ────────────────┐
                 │  logins and cookies are shared, live                                         │
                 │                                                                              │
 Claude Code ──► │  Pod "claude-code-x1"  (own window: its tabs and popups only)                │
 Codex ───────►  │  Pod "codex-k9"        (own window)                                          │
 Cursor ──────►  │  Pod "cursor-p3"       (own window)                                          │
                 │                                                                              │
 You ─────────►  │  your own windows: no agent can list or touch them                           │
                 └──────────────────────────────────────────────────────────────────────────────┘
```

- **Station:** One Chrome (or Edge/Chromium) runs with a dedicated Specillum profile and a debugging port bound to `127.0.0.1`. You log in there once.
- **Pod:** Every MCP connection gets its own Chrome window. Every tool works only on pages the pod opened itself, plus popups those pages open. Nothing exists to list or reach other pages.
- **Cleanup:** When an agent disconnects, its pod window closes. Your logins stay.
- **Token-efficient snapshots:** The page is summarized as visible interactive elements, one line each, with short refs:

```
title: Sign in · Example
url: https://example.com/login
headings:
  h1: Welcome back
elements:
[e1] textbox "Email"
[e2] textbox:password "Password"
[e3] button "Sign in"
[e4] link "Forgot password?" -> /reset
```

## Quick start

Requirements: Node.js 20+ and Google Chrome (Microsoft Edge and Chromium also work).

### 1. Log in once

```bash
npx -y specillum open
```

This opens the Specillum station. Log in to the sites your agents should use. Logins persist in the Specillum profile, separate from your everyday Chrome profile.

### 2. Add Specillum to your agent

**Claude Code**

```bash
claude mcp add specillum -- npx -y specillum
```

On Windows, if `npx` is not found, use `claude mcp add specillum -- cmd /c npx -y specillum`.

**OpenAI Codex** (`~/.codex/config.toml`)

```toml
[mcp_servers.specillum]
command = "npx"
args = ["-y", "specillum"]
```

**Cursor** (`~/.cursor/mcp.json`) and other MCP clients

```json
{
  "mcpServers": {
    "specillum": { "command": "npx", "args": ["-y", "specillum"] }
  }
}
```

### 3. Use it

Ask your agent to do something on the web, for example: *"Check my open GitHub notifications and summarize them."* A new pod window appears, and you can watch it work or click in to take over.

## Tools

| Tool | What it does |
|---|---|
| `pod_status` | This agent's pod label and its tabs |
| `pod_window` | Show this pod's window to the user, or minimize it to the taskbar |
| `navigate` | Open a URL in the active tab |
| `history` | Back / forward |
| `snapshot` | Compact view of the page with element refs (`[e12]`) (iframes included) |
| `read` | Page text as plain text (main content by default) |
| `network` | JSON responses this pod's tabs received (fetch/XHR), read-only |
| `response` | One response's JSON body, redacted and size-capped; `path` picks a part |
| `page_data` | Data the page embeds: JSON-LD, `__NEXT_DATA__`, JSON script tags |
| `click` | Click by ref |
| `type` | Fill an input by ref, optionally press Enter |
| `press` | Keyboard key or shortcut |
| `select` | Choose `<select>` options |
| `hover` | Hover by ref |
| `scroll` | Scroll by screens, or scroll a ref into view |
| `wait` | Wait for text or a fixed time |
| `screenshot` | JPEG of the active tab |
| `dialog` | Accept or dismiss the next `confirm` / `prompt` dialog (alerts are accepted, confirms dismissed by default) |
| `tabs` | List, open, switch, or close tabs **of this pod only** |
| `evaluate` | Run a JavaScript expression in the active tab |
| `recipe` | Save, list, show, run or delete a series of steps for one site |

Action tools accept `snapshot: true` to return a fresh snapshot in the same call.

Recipes let an agent repeat a task without reading the page again. Steps find elements by the role and name the snapshot prints, in any iframe, so they survive layout changes. A run stops at the first step that fails, including an `expect` step whose text never appears, and returns the page so the agent can fix the recipe:

```json
{
  "action": "save",
  "name": "place_search",
  "site": "naver.com",
  "params": ["query"],
  "steps": [
    { "do": "goto", "url": "https://map.naver.com/" },
    { "do": "type", "role": "combobox", "name": "네이버지도 검색", "text": "{query}", "submit": true },
    { "do": "expect", "text": "{query}" }
  ]
}
```

Then run it with `{ "action": "run", "name": "place_search", "values": { "query": "Gwanghwamun" } }`. Other steps are `click`, `press` and `click_at`, which takes coordinates for what has no element, such as a map canvas. It must be followed by `expect` and only runs at the viewport size it was saved with.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `SPECILLUM_PORT` | `9333` | Station debugging port (localhost only) |
| `SPECILLUM_PROFILE` | `%LOCALAPPDATA%\specillum\profile` (Windows), `~/Library/Application Support/specillum/profile` (macOS), `~/.config/specillum/profile` (Linux) | Station profile directory |
| `SPECILLUM_CHROME` | auto-detected | Browser executable |
| `SPECILLUM_POD` | `<client>-<random>` | Fixed pod label |
| `SPECILLUM_KEEP_POD` | unset | Set to `1` to keep the pod window after the agent exits |
| `SPECILLUM_POD_WINDOW` | `visible` | `minimized` opens the pod window in the taskbar; it keeps working there |
| `SPECILLUM_WINDOW` | `1280x900` | Pod window size |
| `SPECILLUM_RECIPES` | `recipes` next to the profile directory | Directory for saved recipes |

## Security model

Read this before you log in to anything important.

- **Separate profile.** Specillum never touches your everyday Chrome profile. Only sites you log in to in the station are available to agents. Start with accounts you would be comfortable letting an assistant use.
- **Localhost port.** The station listens on `127.0.0.1` only. Any program running on your machine as you could connect to that port while the station is open. Close the station when you are not using it.
- **Isolation is between agents and windows, not between sites.** Pods share cookies on purpose. That is how logins work. An agent in its pod can use any site you are logged in to in the station.
- **Prompt injection.** Web pages can contain text meant to manipulate agents. Keep the agent's permissions and the station's logins as narrow as the task needs.
- **Data tools are read-only and redacted.** `network`, `response` and `page_data` only read what this pod's own tabs already received. They never return headers, mask secret-looking keys (token, password, session, csrf…) and token-shaped values (JWT, `Bearer …`, common API key formats), and cap every result. Masking is a safety net, not a guarantee: the agent can still read the page itself.
- **Recipes are shared and stay on their site.** Every pod on the station can run a saved recipe, and recipes are plain JSON files on disk, so keep secrets out of their steps. A run stops if the tab leaves the recipe's site, and it refuses to type into password fields.
- **Open source, no telemetry.** Specillum itself sends no data anywhere, and every line is in this repository. Chrome keeps its own settings and telemetry as usual.

## FAQ

**How do I let Claude Code use my logged-in browser?**
Add Specillum as an MCP server (`claude mcp add specillum -- npx -y specillum`), run `npx specillum open`, and log in once. Claude Code then browses in its own pod window with those logins.

**Can several AI agents use one browser at the same time without interfering?**
Yes. That is what Specillum is for. Each MCP connection gets its own pod window. Tabs, focus and history are separate, and an agent cannot list or reach another pod's pages or yours.

**Does it work with OpenAI Codex, Cursor, Windsurf or other MCP clients?**
Yes. Any client that can launch a stdio MCP server can use Specillum.

**Does it work on Windows?**
Yes. It was developed and tested on Windows. macOS and Linux browser paths are built in.

**Why not just use my normal Chrome profile?**
Since Chrome 136, remote debugging is blocked on the default profile for security reasons. A dedicated profile also limits what agents can reach to the logins you chose.

**Is Specillum an alternative to agent browsers like ego lite or Vercel agent-browser?**
It covers the same idea: agents using a real, logged-in browser with separate spaces. It does this as a small, fully open-source MCP server on top of the Chrome you already have, with no custom browser binary.

**How is this different from Playwright MCP or chrome-devtools-mcp?**
Those connect an agent to a browser. Specillum adds the pod layer: a shared logged-in station, one isolated window per agent, and cleanup on disconnect. It uses Playwright under the hood.

## Using Specillum in your own project

You are welcome to use, modify and redistribute Specillum, commercially or not, under the [Apache License 2.0](LICENSE). The one thing asked in return is credit:

- Keep the [`NOTICE`](NOTICE) file with any copy or derivative work, as the license requires.
- Mention the project in your README or docs, for example:

  > Built on [Specillum](https://github.com/jasonwpgml/specillum) by Jason ([@jasonwpgml](https://github.com/jasonwpgml)).

- GitHub's **"Cite this repository"** button uses [`CITATION.cff`](CITATION.cff).

And if it helped, a star is always appreciated.

## Contributing

Issues and pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md). Run `npm run smoke` to check two-agent isolation end to end.

## License

[Apache-2.0](LICENSE) © 2026 Jason ([@jasonwpgml](https://github.com/jasonwpgml)). See [NOTICE](NOTICE).
