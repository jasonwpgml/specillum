# Specillum

[English](README.md) | [한국어](README.ko.md) | [日本語](README.ja.md) | **简体中文** | [Español](README.es.md)

**在你自己已登录的 Chrome 中，为 AI 智能体提供相互隔离的浏览器舱。**

Specillum 是一个开源的 [MCP](https://modelcontextprotocol.io) 服务器，让 **Claude Code**、**OpenAI Codex**、**Cursor** 等 AI 智能体使用你真实的登录状态浏览网页，同时为**每个智能体分配一个独立的私有浏览器窗口（即“舱（pod）”）**。智能体既看不到也碰不到你的标签页，彼此之间也互不干扰。

*Specillum* 在拉丁语中意为**探针**。所有智能体都从同一个共享的主站（station）出发，各自作为一枚独立的探针向外探索。

[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![MCP](https://img.shields.io/badge/MCP-server-black.svg)](https://modelcontextprotocol.io)

> 如果 Specillum 对你有帮助，请给仓库**点个 Star**，这能让更多人发现它。

---

## 为什么需要 Specillum

大多数面向智能体的浏览器工具只能二选一：

- **全新的无头浏览器**：没有任何登录状态，智能体处处碰到登录墙。
- **你自己的浏览器**：所有智能体共用同一组标签页，既互相干扰，也会干扰你。

Specillum 兼得两者之长：

| | 全新浏览器（如默认配置的 Playwright MCP） | 共用你的浏览器 | **Specillum** |
|---|---|---|---|
| 使用你实时的登录状态 | 否 | 是 | **是** |
| 每个智能体拥有独立空间 | 是 | 否 | **是** |
| 智能体无法访问你的标签页 | 是 | 否 | **是** |
| 你可以随时旁观和接管 | 仅限有头模式 | 是 | **是** |
| 多个智能体同时运行 | 各开一个浏览器 | 相互冲突 | **一个浏览器，每个智能体一个舱** |

## 工作原理

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

- **主站：** 一个 Chrome（或 Edge/Chromium）实例，使用专用的 Specillum 配置文件（profile）运行，调试端口绑定在 `127.0.0.1` 上。你只需在这里登录一次。
- **舱：** 每个 MCP 连接都会获得一个独立的 Chrome 窗口。所有工具只能操作该舱自己打开的页面，以及这些页面弹出的窗口。根本不存在能列出或访问其他页面的途径。
- **自动清理：** 智能体断开连接后，它的舱窗口会随之关闭，你的登录状态保持不变。
- **节省 token 的快照：** 页面会被概括为可见的可交互元素，每个元素占一行，并附带简短的引用（ref）：

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

## 快速开始

环境要求：Node.js 20+ 和 Google Chrome（Microsoft Edge 与 Chromium 同样可用）。

### 1. 登录一次

```bash
npx -y specillum open
```

该命令会打开 Specillum 主站。在其中登录你希望智能体使用的网站即可。登录状态保存在 Specillum 配置文件中，与你日常使用的 Chrome 配置文件相互独立。

### 2. 将 Specillum 添加到你的智能体

**Claude Code**

```bash
claude mcp add specillum -- npx -y specillum
```

在 Windows 上，如果提示找不到 `npx`，请改用 `claude mcp add specillum -- cmd /c npx -y specillum`。

**OpenAI Codex**（`~/.codex/config.toml`）

```toml
[mcp_servers.specillum]
command = "npx"
args = ["-y", "specillum"]
```

**Cursor**（`~/.cursor/mcp.json`）及其他 MCP 客户端

```json
{
  "mcpServers": {
    "specillum": { "command": "npx", "args": ["-y", "specillum"] }
  }
}
```

### 3. 开始使用

让智能体在网上帮你做点事，例如：*“查看我在 GitHub 上未处理的通知，并做个汇总。”* 屏幕上会出现一个新的舱窗口，你可以旁观它工作，也可以随时点进去接管。

## 工具

| 工具 | 功能 |
|---|---|
| `pod_status` | 当前智能体的舱标识及其标签页 |
| `pod_window` | 将本舱窗口显示给用户，或最小化到任务栏 |
| `navigate` | 在当前标签页中打开 URL |
| `history` | 后退 / 前进 |
| `snapshot` | 页面的精简视图，附带元素引用（`[e12]`） （包含 iframe） |
| `read` | 以纯文本形式获取页面文字（默认只取正文） |
| `click` | 按引用点击元素 |
| `type` | 按引用填写输入框，可选择随后按下 Enter |
| `press` | 按下键盘按键或快捷键 |
| `select` | 选择 `<select>` 中的选项 |
| `hover` | 按引用悬停 |
| `scroll` | 按屏滚动，或将某个引用对应的元素滚动到可视区域 |
| `wait` | 等待指定文本出现，或等待固定时长 |
| `screenshot` | 当前标签页的 JPEG 截图 |
| `dialog` | 接受或取消下一个 `confirm` / `prompt` 对话框（默认接受 alert、取消 confirm） |
| `tabs` | 列出、打开、切换或关闭标签页（**仅限本舱**） |
| `evaluate` | 在当前标签页中执行一段 JavaScript 表达式 |

操作类工具均支持 `snapshot: true` 参数，可在同一次调用中直接返回最新快照。

## 配置

| 变量 | 默认值 | 用途 |
|---|---|---|
| `SPECILLUM_PORT` | `9333` | 主站调试端口（仅限本机访问） |
| `SPECILLUM_PROFILE` | `%LOCALAPPDATA%\specillum\profile`（Windows）、`~/Library/Application Support/specillum/profile`（macOS）、`~/.config/specillum/profile`（Linux） | 主站配置文件目录 |
| `SPECILLUM_CHROME` | 自动检测 | 浏览器可执行文件路径 |
| `SPECILLUM_POD` | `<client>-<random>` | 固定的舱标识 |
| `SPECILLUM_KEEP_POD` | 未设置 | 设为 `1` 时，智能体退出后保留舱窗口 |
| `SPECILLUM_POD_WINDOW` | `visible` | 设为 `minimized` 时，舱窗口以最小化状态在任务栏中打开，并照常工作 |
| `SPECILLUM_WINDOW` | `1280x900` | 舱窗口大小 |

## 安全模型

在登录任何重要账号之前，请先阅读本节。

- **独立的配置文件。** Specillum 从不触碰你日常使用的 Chrome 配置文件。只有你在主站中登录过的网站，智能体才能使用。建议先从那些你放心交给助手使用的账号开始。
- **仅限本机的端口。** 主站只监听 `127.0.0.1`。但在主站开启期间，你机器上以你的身份运行的任何程序都能连接这个端口。不用时请关闭主站。
- **隔离发生在智能体与窗口之间，而不是网站之间。** 各个舱是有意共享 Cookie 的，登录状态正是靠这一点生效。舱中的智能体可以使用你在主站中登录过的任何网站。
- **提示词注入。** 网页中可能藏有专门用来操纵智能体的文字。请把智能体的权限和主站中登录的账号都限制在任务所需的最小范围内。
- **开源，无遥测。** Specillum 本身不会向任何地方发送数据，每一行代码都在本仓库中。Chrome 自身的设置和遥测则照常运作。

## 常见问题

**如何让 Claude Code 使用我已登录的浏览器？**
将 Specillum 添加为 MCP 服务器（`claude mcp add specillum -- npx -y specillum`），运行 `npx specillum open`，然后登录一次即可。之后 Claude Code 就会在自己的舱窗口中，借助这些登录状态浏览网页。

**多个 AI 智能体能否同时使用同一个浏览器而互不干扰？**
可以，这正是 Specillum 的用途。每个 MCP 连接都有自己的舱窗口，标签页、焦点和历史记录彼此独立。智能体既无法列出或访问其他舱的页面，也无法访问你的页面。

**它支持 OpenAI Codex、Cursor、Windsurf 或其他 MCP 客户端吗？**
支持。任何能够启动 stdio MCP 服务器的客户端都可以使用 Specillum。

**它能在 Windows 上运行吗？**
可以。它本身就是在 Windows 上开发和测试的，同时也内置了 macOS 和 Linux 的浏览器路径。

**为什么不直接用我平时的 Chrome 配置文件？**
从 Chrome 136 开始，出于安全考虑，默认配置文件已禁止远程调试。此外，使用专用配置文件还能把智能体可触及的范围限定在你选定的登录账号内。

**Specillum 能替代 ego lite 或 Vercel agent-browser 这类智能体浏览器吗？**
两者的思路相同：让智能体使用真实的、已登录的浏览器，并各自拥有独立空间。不同之处在于，Specillum 以一个小巧且完全开源的 MCP 服务器来实现这一点，直接运行在你现有的 Chrome 之上，无需任何定制的浏览器二进制文件。

**它与 Playwright MCP 或 chrome-devtools-mcp 有什么区别？**
这些工具负责把智能体连接到浏览器。Specillum 则在此之上增加了舱这一层：一个共享的已登录主站、每个智能体一个隔离窗口，以及断开连接时的自动清理。它的底层使用的正是 Playwright。

## 在你自己的项目中使用 Specillum

你可以依据 [Apache License 2.0](LICENSE) 自由使用、修改和再分发 Specillum，无论是否用于商业用途。作为回报，唯一的请求是注明出处：

- 按照许可证的要求，在任何副本或衍生作品中保留 [`NOTICE`](NOTICE) 文件。
- 在你的 README 或文档中提及本项目，例如：

  > Built on [Specillum](https://github.com/jasonwpgml/specillum) by Jason ([@jasonwpgml](https://github.com/jasonwpgml)).

- GitHub 的 **“Cite this repository”** 按钮读取的是 [`CITATION.cff`](CITATION.cff)。

如果它帮到了你，也欢迎顺手点个 Star。

## 参与贡献

欢迎提交 Issue 和 Pull Request，详见 [CONTRIBUTING.md](CONTRIBUTING.md)。运行 `npm run smoke` 可以端到端地验证双智能体隔离。

## 许可证

[Apache-2.0](LICENSE) © 2026 Jason（[@jasonwpgml](https://github.com/jasonwpgml)）。另见 [NOTICE](NOTICE)。
