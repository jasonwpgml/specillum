# Specillum

[English](README.md) | **한국어** | [日本語](README.ja.md) | [简体中文](README.zh-CN.md) | [Español](README.es.md)

**로그인된 내 Chrome 안에서, AI 에이전트마다 격리된 브라우저 포드를 제공합니다.**

Specillum은 **Claude Code**, **OpenAI Codex**, **Cursor** 같은 AI 에이전트가 실제 로그인 상태 그대로 웹을 탐색할 수 있게 해 주는 오픈소스 [MCP](https://modelcontextprotocol.io) 서버입니다. 이때 **에이전트마다 전용 브라우저 창, 즉 포드(pod)를 하나씩** 제공합니다. 에이전트는 사용자의 탭을 보거나 건드릴 수 없고, 에이전트끼리 서로 간섭하지도 않습니다.

*Specillum*은 라틴어로 **탐침**(probe)이라는 뜻입니다. 하나의 공유 스테이션(station)에서 각 에이전트가 저마다의 탐침이 되어 뻗어 나갑니다.

[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![MCP](https://img.shields.io/badge/MCP-server-black.svg)](https://modelcontextprotocol.io)

> Specillum이 유용했다면 **저장소에 스타**를 눌러 주세요. 다른 사람들이 이 프로젝트를 찾는 데 도움이 됩니다.

---

## 왜 Specillum인가

에이전트용 브라우저 도구는 대개 다음 둘 중 하나입니다.

- **새로 띄운 헤드리스 브라우저**: 로그인 정보가 없어서 에이전트가 가는 곳마다 로그인 화면에 막힙니다.
- **사용자의 실제 브라우저**: 모든 에이전트가 같은 탭을 공유합니다. 에이전트끼리는 물론 사용자와도 서로 간섭합니다.

Specillum은 두 방식의 장점을 모두 취합니다.

| | 새 브라우저 (예: 기본 Playwright MCP) | 내 브라우저 공유 | **Specillum** |
|---|---|---|---|
| 실시간 로그인 상태 사용 | 아니요 | 예 | **예** |
| 에이전트별 독립 공간 | 예 | 아니요 | **예** |
| 에이전트가 내 탭에 접근 불가 | 예 | 아니요 | **예** |
| 작업을 지켜보다가 직접 넘겨받기 | 창을 띄우는(headed) 모드에서만 | 예 | **예** |
| 여러 에이전트 동시 실행 | 브라우저를 따로 띄움 | 충돌 발생 | **브라우저 하나, 에이전트마다 포드 하나** |

## 작동 방식

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

- **스테이션:** 전용 Specillum 프로필과 `127.0.0.1`에 바인딩된 디버깅 포트로 Chrome(또는 Edge/Chromium) 하나를 실행합니다. 로그인은 여기서 한 번만 하면 됩니다.
- **포드:** MCP 연결마다 별도의 Chrome 창이 생깁니다. 모든 도구는 포드가 직접 연 페이지와, 그 페이지가 띄운 팝업에서만 동작합니다. 다른 페이지를 나열하거나 접근할 수단 자체가 없습니다.
- **정리:** 에이전트의 연결이 끊기면 해당 포드 창이 닫힙니다. 로그인 상태는 그대로 유지됩니다.
- **토큰 효율적인 스냅샷:** 페이지를 화면에 보이는 상호작용 가능한 요소 목록으로 요약합니다. 요소마다 한 줄씩, 짧은 참조(ref)를 붙입니다.

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

## 빠른 시작

요구 사항: Node.js 20 이상, Google Chrome (Microsoft Edge와 Chromium도 사용할 수 있습니다)

### 1. 한 번만 로그인하기

```bash
npx -y specillum open
```

이 명령은 Specillum 스테이션을 엽니다. 에이전트가 사용할 사이트에 로그인하세요. 로그인 정보는 Specillum 프로필에 저장되며, 평소 사용하는 Chrome 프로필과는 분리되어 있습니다.

### 2. 에이전트에 Specillum 추가하기

**Claude Code**

```bash
claude mcp add specillum -- npx -y specillum
```

Windows에서 `npx`를 찾을 수 없다면 `claude mcp add specillum -- cmd /c npx -y specillum`을 사용하세요.

**OpenAI Codex** (`~/.codex/config.toml`)

```toml
[mcp_servers.specillum]
command = "npx"
args = ["-y", "specillum"]
```

**Cursor** (`~/.cursor/mcp.json`) 및 기타 MCP 클라이언트

```json
{
  "mcpServers": {
    "specillum": { "command": "npx", "args": ["-y", "specillum"] }
  }
}
```

### 3. 사용하기

에이전트에게 웹에서 할 일을 요청해 보세요. 예를 들면 *"내 GitHub 알림을 확인하고 요약해 줘."* 같은 요청입니다. 새 포드 창이 나타나며, 작업 과정을 지켜보다가 언제든 창을 클릭해 직접 넘겨받을 수 있습니다.

## 도구

| 도구 | 기능 |
|---|---|
| `pod_status` | 이 에이전트의 포드 라벨과 탭 목록 |
| `pod_window` | 이 포드 창을 사용자에게 띄우거나 작업 표시줄로 최소화 |
| `navigate` | 활성 탭에서 URL 열기 |
| `history` | 뒤로 / 앞으로 이동 |
| `snapshot` | 요소 참조(`[e12]`)가 포함된 간결한 페이지 뷰 (iframe 포함) |
| `read` | 페이지 내용을 일반 텍스트로 읽기 (기본값은 본문만) |
| `network` | 이 포드의 탭이 받은 JSON 응답(fetch/XHR) 목록, 읽기 전용 |
| `response` | 응답 하나의 JSON 본문. 민감한 값은 가리고 크기는 제한하며, `path`로 일부만 꺼냄 |
| `page_data` | 페이지에 박혀 있는 데이터: JSON-LD, `__NEXT_DATA__`, JSON 스크립트 태그 |
| `click` | 참조로 지정한 요소 클릭 |
| `type` | 참조로 지정한 입력란 채우기, 필요하면 Enter 입력 |
| `press` | 키보드 키 또는 단축키 입력 |
| `select` | `<select>` 옵션 선택 |
| `hover` | 참조로 지정한 요소에 마우스 올리기 |
| `scroll` | 화면 단위로 스크롤하거나, 참조한 요소가 보이도록 스크롤 |
| `wait` | 특정 텍스트가 나타나거나 지정한 시간이 지날 때까지 대기 |
| `screenshot` | 활성 탭의 JPEG 스크린샷 |
| `dialog` | 다음에 뜨는 `confirm`·`prompt` 대화상자를 수락하거나 취소 (기본값: alert는 수락, confirm은 취소) |
| `tabs` | **이 포드의 탭만** 나열, 열기, 전환, 닫기 |
| `evaluate` | 활성 탭에서 JavaScript 표현식 실행 |

액션 도구에 `snapshot: true`를 지정하면 같은 호출에서 최신 스냅샷을 함께 반환합니다.

## 설정

| 변수 | 기본값 | 용도 |
|---|---|---|
| `SPECILLUM_PORT` | `9333` | 스테이션 디버깅 포트 (localhost 전용) |
| `SPECILLUM_PROFILE` | `%LOCALAPPDATA%\specillum\profile` (Windows), `~/Library/Application Support/specillum/profile` (macOS), `~/.config/specillum/profile` (Linux) | 스테이션 프로필 디렉터리 |
| `SPECILLUM_CHROME` | 자동 감지 | 브라우저 실행 파일 |
| `SPECILLUM_POD` | `<client>-<random>` | 고정 포드 라벨 |
| `SPECILLUM_KEEP_POD` | 설정 안 됨 | `1`로 설정하면 에이전트가 종료된 뒤에도 포드 창을 유지 |
| `SPECILLUM_POD_WINDOW` | `visible` | `minimized`로 설정하면 포드 창이 작업 표시줄에 최소화된 채 열리고, 그 상태로도 작동 |
| `SPECILLUM_WINDOW` | `1280x900` | 포드 창 크기 |

## 보안 모델

중요한 계정에 로그인하기 전에 꼭 읽어 주세요.

- **별도 프로필.** Specillum은 평소 사용하는 Chrome 프로필을 절대 건드리지 않습니다. 에이전트가 사용할 수 있는 것은 스테이션에서 로그인한 사이트뿐입니다. 처음에는 어시스턴트에게 맡겨도 괜찮다고 생각되는 계정부터 시작하세요.
- **localhost 포트.** 스테이션은 `127.0.0.1`에서만 연결을 받습니다. 다만 스테이션이 열려 있는 동안에는 내 계정 권한으로 실행 중인 모든 프로그램이 이 포트에 접속할 수 있습니다. 사용하지 않을 때는 스테이션을 닫아 두세요.
- **격리는 사이트 사이가 아니라 에이전트와 창 사이에 적용됩니다.** 포드끼리는 의도적으로 쿠키를 공유합니다. 로그인이 유지되는 원리가 바로 이것입니다. 포드 안의 에이전트는 스테이션에서 로그인해 둔 모든 사이트를 사용할 수 있습니다.
- **프롬프트 인젝션.** 웹 페이지에는 에이전트를 조종하려는 의도의 텍스트가 들어 있을 수 있습니다. 에이전트의 권한과 스테이션의 로그인 범위는 작업에 꼭 필요한 만큼만 좁게 유지하세요.
- **데이터 도구는 읽기 전용이고 민감한 값을 가립니다.** `network`, `response`, `page_data`는 이 포드의 탭이 이미 받은 데이터만 읽습니다. 헤더는 보여 주지 않고, 민감해 보이는 키(token, password, session, csrf 등)와 토큰 모양의 값(JWT, `Bearer …`, 흔한 API 키 형식)을 가리며, 모든 결과의 크기를 제한합니다. 가리기는 안전장치일 뿐 보장이 아닙니다. 에이전트는 여전히 페이지 자체를 읽을 수 있습니다.
- **오픈소스, 텔레메트리 없음.** Specillum 자체는 어디로도 데이터를 보내지 않으며, 모든 코드가 이 저장소에 공개되어 있습니다. Chrome은 평소처럼 자체 설정과 텔레메트리를 그대로 유지합니다.

## 자주 묻는 질문

**Claude Code가 로그인된 내 브라우저를 사용하게 하려면 어떻게 하나요?**
Specillum을 MCP 서버로 추가하고(`claude mcp add specillum -- npx -y specillum`), `npx specillum open`을 실행한 뒤 한 번 로그인하세요. 그러면 Claude Code가 그 로그인 상태로 자신의 포드 창에서 웹을 탐색합니다.

**여러 AI 에이전트가 서로 간섭하지 않고 브라우저 하나를 동시에 사용할 수 있나요?**
네. Specillum이 바로 그 용도로 만들어졌습니다. MCP 연결마다 별도의 포드 창이 할당됩니다. 탭, 포커스, 방문 기록이 모두 분리되며, 에이전트는 다른 포드의 페이지나 사용자의 페이지를 나열하거나 접근할 수 없습니다.

**OpenAI Codex, Cursor, Windsurf 같은 다른 MCP 클라이언트에서도 동작하나요?**
네. stdio MCP 서버를 실행할 수 있는 클라이언트라면 어디서든 Specillum을 사용할 수 있습니다.

**Windows에서도 동작하나요?**
네. Windows에서 개발하고 테스트했습니다. macOS와 Linux의 브라우저 경로도 기본으로 내장되어 있습니다.

**그냥 평소 쓰는 Chrome 프로필을 사용하면 안 되나요?**
Chrome 136부터는 보안상의 이유로 기본 프로필에서 원격 디버깅이 차단됩니다. 또한 전용 프로필을 쓰면 에이전트가 접근할 수 있는 범위를 사용자가 직접 고른 로그인으로 한정할 수 있습니다.

**Specillum은 ego lite나 Vercel agent-browser 같은 에이전트 브라우저의 대안인가요?**
같은 아이디어를 다룹니다. 에이전트가 각자 분리된 공간에서, 로그인된 실제 브라우저를 사용한다는 점입니다. Specillum은 이를 별도의 커스텀 브라우저 바이너리 없이, 이미 설치된 Chrome 위에서 동작하는 작은 완전 오픈소스 MCP 서버로 구현합니다.

**Playwright MCP나 chrome-devtools-mcp와는 무엇이 다른가요?**
그 도구들은 에이전트를 브라우저에 연결해 줍니다. Specillum은 여기에 포드 계층을 더합니다. 로그인 상태가 공유되는 스테이션, 에이전트마다 하나씩 격리된 창, 연결이 끊겼을 때의 자동 정리가 그것입니다. 내부적으로는 Playwright를 사용합니다.

## 내 프로젝트에서 Specillum 사용하기

Specillum은 [Apache License 2.0](LICENSE)에 따라 상업적 용도 여부와 관계없이 자유롭게 사용, 수정, 재배포할 수 있습니다. 그 대신 한 가지만 부탁드립니다. 출처를 밝혀 주세요.

- 라이선스 요구 사항에 따라, 사본이나 파생 저작물에는 [`NOTICE`](NOTICE) 파일을 함께 포함해 주세요.
- README나 문서에 이 프로젝트를 언급해 주세요. 예를 들면 다음과 같습니다.

  > Built on [Specillum](https://github.com/jasonwpgml/specillum) by Jason ([@jasonwpgml](https://github.com/jasonwpgml)).

- GitHub의 **"Cite this repository"** 버튼은 [`CITATION.cff`](CITATION.cff)를 사용합니다.

도움이 되었다면 스타 하나도 언제나 큰 힘이 됩니다.

## 기여하기

이슈와 풀 리퀘스트는 언제든 환영합니다. [CONTRIBUTING.md](CONTRIBUTING.md)를 참고하세요. `npm run smoke`를 실행하면 두 에이전트 사이의 격리를 처음부터 끝까지(end-to-end) 검증할 수 있습니다.

## 라이선스

[Apache-2.0](LICENSE) © 2026 Jason ([@jasonwpgml](https://github.com/jasonwpgml)). 자세한 내용은 [NOTICE](NOTICE)를 참고하세요.
