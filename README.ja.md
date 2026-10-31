# Specillum

[English](README.md) | [한국어](README.ko.md) | **日本語** | [简体中文](README.zh-CN.md) | [Español](README.es.md)

**ログイン済みのいつもの Chrome の中で、AI エージェントごとに分離されたブラウザポッド（pod）を。**

Specillum は、**Claude Code**、**OpenAI Codex**、**Cursor** などの AI エージェントが、あなたの実際のログイン状態のまま Web を閲覧できるようにするオープンソースの [MCP](https://modelcontextprotocol.io) サーバーです。同時に、**各エージェントには専用のプライベートなブラウザウィンドウ（「ポッド」）が与えられます**。エージェントがあなたのタブを見たり操作したりすることはなく、エージェント同士が干渉し合うこともありません。

*Specillum* はラテン語で「**探針**（probe）」を意味します。共有された 1 つのステーション（station）から、各エージェントがそれぞれ独立した探針として送り出されます。

[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![MCP](https://img.shields.io/badge/MCP-server-black.svg)](https://modelcontextprotocol.io)

> Specillum が役に立ったら、ぜひ**リポジトリにスターを付けてください**。ほかの人が見つけやすくなります。

---

## なぜ Specillum なのか

エージェント向けのブラウザツールの多くは、次のどちらかです。

- **まっさらなヘッドレスブラウザ**。ログイン情報がないため、エージェントは至るところでサインイン画面に阻まれます。
- **あなたの実際のブラウザ**。すべてのエージェントが同じタブを共有するため、エージェント同士で、またあなたの操作とも干渉し合います。

Specillum は、この両方の利点を兼ね備えています。

| | まっさらなブラウザ（例: デフォルトの Playwright MCP） | 自分のブラウザを共有 | **Specillum** |
|---|---|---|---|
| ログイン中のアカウントをそのまま使える | いいえ | はい | **はい** |
| エージェントごとに専用の空間がある | はい | いいえ | **はい** |
| エージェントがあなたのタブに触れられない | はい | いいえ | **はい** |
| 様子を見守り、操作を引き継げる | ヘッドありモードのみ | はい | **はい** |
| 複数エージェントの同時実行 | 別々のブラウザ | 衝突する | **1 つのブラウザに各 1 ポッド** |

## 仕組み

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

- **ステーション:** Chrome（または Edge / Chromium）を 1 つ、Specillum 専用のプロファイルと `127.0.0.1` にバインドしたデバッグポートで起動します。ログインはここで一度だけ行います。
- **ポッド:** MCP 接続ごとに専用の Chrome ウィンドウが割り当てられます。各ツールが操作できるのは、そのポッド自身が開いたページと、それらのページが開いたポップアップだけです。ほかのページを一覧表示したりアクセスしたりする手段は、そもそも存在しません。
- **クリーンアップ:** エージェントが切断すると、そのポッドのウィンドウは閉じられます。ログイン状態はそのまま残ります。
- **トークン効率の良いスナップショット:** ページは、画面に表示されている操作可能な要素を 1 行に 1 つずつ、短い参照（ref）付きで要約した形で渡されます。

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

## クイックスタート

動作要件: Node.js 20 以上と Google Chrome（Microsoft Edge や Chromium でも動作します）。

### 1. 最初に一度ログインする

```bash
npx -y specillum open
```

これで Specillum のステーションが開きます。エージェントに使わせたいサイトにログインしてください。ログイン状態は Specillum のプロファイルに保存され、普段お使いの Chrome プロファイルとは分離されています。

### 2. エージェントに Specillum を追加する

**Claude Code**

```bash
claude mcp add specillum -- npx -y specillum
```

Windows で `npx` が見つからない場合は、`claude mcp add specillum -- cmd /c npx -y specillum` を使用してください。

**OpenAI Codex** (`~/.codex/config.toml`)

```toml
[mcp_servers.specillum]
command = "npx"
args = ["-y", "specillum"]
```

**Cursor** (`~/.cursor/mcp.json`) およびその他の MCP クライアント

```json
{
  "mcpServers": {
    "specillum": { "command": "npx", "args": ["-y", "specillum"] }
  }
}
```

### 3. 使ってみる

エージェントに Web 上での作業を依頼してみましょう。たとえば *「GitHub の未読の通知を確認して、要約して」* のように頼みます。新しいポッドのウィンドウが現れ、作業の様子を見守ることも、クリックして操作を引き継ぐこともできます。

## ツール

| ツール | 機能 |
|---|---|
| `pod_status` | このエージェントのポッドのラベルと、そのタブ |
| `pod_window` | このポッドのウィンドウをユーザーに表示する、またはタスクバーに最小化する |
| `navigate` | アクティブなタブで URL を開く |
| `history` | 戻る / 進む |
| `snapshot` | 要素の参照（`[e12]`）付きで、ページをコンパクトに表示 （iframe を含む）。`match` で特定の要素を探し、`changes` で変更点のみを返す |
| `read` | ページの内容をプレーンテキストで取得（デフォルトではメインコンテンツ） |
| `network` | このポッドのタブが受け取った JSON レスポンス（fetch/XHR）の一覧。読み取り専用 |
| `response` | 1 件のレスポンスの JSON 本文。秘密情報を伏せ、サイズを制限し、`path` で一部だけ取り出す |
| `page_data` | ページに埋め込まれたデータ：JSON-LD、`__NEXT_DATA__`、JSON の script タグ |
| `click` | ref を指定してクリック。別の要素に覆われている場合はエラーでその要素を示す |
| `type` | ref を指定して入力欄に入力し、必要に応じて Enter を押す |
| `press` | キーまたはショートカットを押す |
| `select` | `<select>` の選択肢を選ぶ |
| `hover` | ref を指定してホバー |
| `drag` | ref を指定して要素を別の要素の上へドラッグ |
| `upload` | ファイル入力欄やファイル選択画面にローカルファイルを添付 |
| `scroll` | 画面単位でスクロール、または ref の要素が見えるまでスクロール |
| `wait` | テキストの出現や消失、URL の変化、または一定時間を待つ |
| `screenshot` | アクティブなタブの JPEG。`annotate` で要素に参照を表示 |
| `dialog` | 次に出る `confirm` / `prompt` ダイアログを承諾または拒否する（既定では alert は承諾、confirm は拒否） |
| `tabs` | **このポッドのタブに限り**、一覧表示・作成・切り替え・クローズを行う |
| `console` | このポッドのタブのコンソールメッセージと未処理のエラー |
| `evaluate` | アクティブなタブで JavaScript の式を実行 |
| `recipe` | 1 つのサイトに対する一連の手順を保存・一覧表示・表示・実行・削除する |

操作系のツールに `snapshot: true` を指定すると、同じ呼び出しの中で最新のスナップショットも返され、`snapshot: "changes"` を指定すると変更点のみが返されます。ツールの結果にはダウンロードの通知も含まれます。

レシピを使うと、エージェントはページを読み直さずに同じ作業を繰り返せます。各手順はスナップショットに表示されるロールと名前で要素を探し、iframe の中も対象にするため、レイアウトが変わっても動作します。実行は最初に失敗した手順で止まり（`expect` のテキストが現れない場合を含む）、エージェントがレシピを直せるようにページの状態を返します。

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

実行は `{ "action": "run", "name": "place_search", "values": { "query": "光化門" } }` のように行います。ほかの手順には `click`、`press`、`click_at` があります。`click_at` は地図のキャンバスのように要素がない場所を座標でクリックするもので、直後に `expect` が必要で、保存時と同じビューポートサイズでのみ実行されます。

## 設定

| 変数 | デフォルト | 用途 |
|---|---|---|
| `SPECILLUM_PORT` | `9333` | ステーションのデバッグポート（localhost のみ） |
| `SPECILLUM_PROFILE` | `%LOCALAPPDATA%\specillum\profile`（Windows）、`~/Library/Application Support/specillum/profile`（macOS）、`~/.config/specillum/profile`（Linux） | ステーションのプロファイルディレクトリ |
| `SPECILLUM_CHROME` | 自動検出 | ブラウザの実行ファイル |
| `SPECILLUM_POD` | `<client>-<random>` | 固定のポッドラベル |
| `SPECILLUM_KEEP_POD` | 未設定 | `1` を指定すると、エージェントの終了後もポッドのウィンドウを残す |
| `SPECILLUM_POD_WINDOW` | `visible` | `minimized` にするとポッドのウィンドウはタスクバーに最小化された状態で開き、そのまま動作する |
| `SPECILLUM_HEADLESS` | 未設定 | `1` にするとウィンドウなしでステーションを実行。画面の確認やログインはできず、サイトからヘッドレスだと判別される場合がある。`specillum open` は常にブラウザを表示するため、先にヘッドレスのステーションを閉じること |
| `SPECILLUM_WINDOW` | `1280x900` | ポッドのウィンドウサイズ |
| `SPECILLUM_RECIPES` | プロファイルディレクトリの隣の `recipes` | 保存したレシピのディレクトリ |
| `SPECILLUM_ALLOWED_DOMAINS` | すべてのサイト | ポッドが開けるサイトをカンマ区切りで指定（サブドメインを含む） |
| `SPECILLUM_UPLOAD_DIRS` | なし | エージェントの実行ディレクトリ以外にアップロードを許可するディレクトリ |

## セキュリティモデル

重要なサービスにログインする前に、必ずお読みください。

- **プロファイルは分離されています。** Specillum が普段お使いの Chrome プロファイルに触れることはありません。エージェントが利用できるのは、ステーションでログインしたサイトだけです。まずは、アシスタントに使わせても差し支えないアカウントから始めてください。
- **ポートは localhost のみで待ち受けます。** ステーションは `127.0.0.1` でのみ接続を受け付けます。ただし、ステーションが開いている間は、あなたのユーザー権限でこのマシン上で動作しているプログラムであれば、どれでもこのポートに接続できます。使わないときはステーションを閉じてください。
- **分離の単位はエージェントとウィンドウであり、サイトではありません。** ポッド同士は意図的に Cookie を共有しています。ログインが共有されるのはこの仕組みによるものです。ポッド内のエージェントは、ステーションでログイン済みのどのサイトでも利用できます。
- **プロンプトインジェクション。** Web ページには、エージェントを操る目的で書かれたテキストが含まれている場合があります。エージェントの権限とステーションのログインは、タスクに必要な範囲に絞ってください。
- **ポッドの行き先を制限できます。** `SPECILLUM_ALLOWED_DOMAINS` を設定すると、ポッドのタブと iframe は他のサイトを開けなくなります。タスクに必要なサイトだけを指定してください。これは安全策であり、セキュリティ境界ではありません。他サイトへのリダイレクトはリクエストの送信後にしか検出できず、ページは引き続き他の場所からリソースを読み込めます。
- **アップロードはエージェントの周辺に限られます。** `upload` はエージェントの実行ディレクトリと `SPECILLUM_UPLOAD_DIRS` のファイルのみを受け付け、リンクをたどった実際のパスで確認します。これらのディレクトリ内のファイルはすべて Web サイトへ送信される可能性があります。
- **データツールは読み取り専用で、秘密情報を伏せます。** `network`、`response`、`page_data` は、このポッドのタブがすでに受け取ったものだけを読みます。ヘッダーは返さず、秘密らしいキー（token、password、session、csrf など）とトークン形式の値（JWT、`Bearer …`、一般的な API キー形式）を伏せ、すべての結果のサイズを制限します。伏せ字は安全網であり保証ではありません。エージェントはページ自体を読むことができます。
- **レシピは共有され、指定したサイトの中でのみ動きます。** ステーションのすべてのポッドが保存済みのレシピを実行でき、レシピはディスク上の通常の JSON ファイルなので、手順に秘密情報を入れないでください。タブがレシピのサイトを離れると実行は止まり、パスワード欄には入力しません。
- **オープンソースで、テレメトリなし。** Specillum 自体はどこにもデータを送信せず、すべてのコードがこのリポジトリで公開されています。Chrome 自体の設定やテレメトリは、通常どおり Chrome 側で管理されます。

## よくある質問

**Claude Code にログイン済みのブラウザを使わせるには？**
Specillum を MCP サーバーとして追加し（`claude mcp add specillum -- npx -y specillum`）、`npx specillum open` を実行して一度ログインします。以降、Claude Code はそのログイン状態を使い、専用のポッドウィンドウで Web を閲覧します。

**複数の AI エージェントが、互いに干渉せずに 1 つのブラウザを同時に使えますか？**
はい。それこそが Specillum の目的です。MCP 接続ごとに専用のポッドウィンドウが割り当てられます。タブ、フォーカス、履歴はそれぞれ独立しており、エージェントがほかのポッドのページやあなたのページを一覧表示したり、アクセスしたりすることはできません。

**OpenAI Codex、Cursor、Windsurf などの MCP クライアントでも使えますか？**
はい。stdio MCP サーバーを起動できるクライアントであれば、どれでも Specillum を使えます。

**Windows で動作しますか？**
はい。Windows 上で開発・テストしています。macOS と Linux のブラウザパスも組み込み済みです。

**普段使っている Chrome のプロファイルをそのまま使えばよいのでは？**
Chrome 136 以降、セキュリティ上の理由から、デフォルトプロファイルではリモートデバッグがブロックされています。また、専用プロファイルを使うことで、エージェントがアクセスできる範囲を、あなたが選んだログインだけに限定できます。

**Specillum は、ego lite や Vercel agent-browser のようなエージェント向けブラウザの代替になりますか？**
目指すところは同じです。つまり、エージェントがログイン済みの実際のブラウザを、それぞれ分離された空間で使えるようにすることです。Specillum はこれを、すでにお使いの Chrome の上で動く、小さな完全オープンソースの MCP サーバーとして実現しています。独自のブラウザバイナリは必要ありません。

**Playwright MCP や chrome-devtools-mcp とは何が違いますか？**
これらは、エージェントをブラウザに接続するためのツールです。Specillum はそこにポッドのレイヤーを加えます。具体的には、ログイン済みの共有ステーション、エージェントごとに 1 つの分離されたウィンドウ、そして切断時のクリーンアップです。内部では Playwright を使用しています。

## 自分のプロジェクトで Specillum を使う

Specillum は [Apache License 2.0](LICENSE) のもとで、商用・非商用を問わず自由に利用・改変・再配布できます。その代わりにお願いしたいのは、クレジットの表記だけです。

- ライセンスの定めに従い、コピーや派生物には [`NOTICE`](NOTICE) ファイルを必ず同梱してください。
- README やドキュメントで、本プロジェクトに言及してください。たとえば次のように記載します。

  > Built on [Specillum](https://github.com/jasonwpgml/specillum) by Jason ([@jasonwpgml](https://github.com/jasonwpgml)).

- GitHub の **「Cite this repository」** ボタンは [`CITATION.cff`](CITATION.cff) を参照しています。

そして、もしお役に立てたなら、スターをいただけるととても励みになります。

## コントリビュート

Issue やプルリクエストを歓迎します。詳しくは [CONTRIBUTING.md](CONTRIBUTING.md) をご覧ください。`npm run smoke` を実行すると、2 つのエージェント間の分離をエンドツーエンドで確認できます。

## ライセンス

[Apache-2.0](LICENSE) © 2026 Jason ([@jasonwpgml](https://github.com/jasonwpgml))。詳しくは [NOTICE](NOTICE) をご覧ください。
