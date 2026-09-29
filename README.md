# Reedar

<img src="assets/icon.png" alt="Reedar: an open book with RSS arcs on a graphite tile" width="128" height="128">

**A quiet RSS reader. A conversation with every article.**

Reedar is a desktop RSS reader for macOS, inspired by the familiar three-pane reading experience. Follow your feeds, organize articles, and ask your existing coding agents to help you understand what you read.

Bring your own CLI login. Reedar uses the agent's existing service access and usage allowance; it does not require a separate model API key.

> **Early preview for macOS on Apple Silicon.** Codex reading is verified with GPT-5.3-Codex-Spark. Claude Code's successful live reading is unverified, and Antigravity reading is disabled. The interface and reading assistant currently use Japanese.
>
> **Download limitations:** the DMG / ZIP previews use ad-hoc signing and are **not notarized**. macOS may block a downloaded app. Installation on another Mac and Intel execution have not been verified. See [Distribution](docs/distribution.md) before installing a build.

[Download v0.1.2 — first public preview](https://github.com/YunosukeYoshino/reedar/releases/tag/v0.1.2)

[Getting started](#getting-started) · [Agent support](#agent-support) · [Roadmap](ROADMAP.md) · [Contributing](CONTRIBUTING.md) · [Validation](docs/validation.md) · [Distribution](docs/distribution.md)

## Features

- **Three-pane reading:** feeds and folders, an article list, and the article itself.
- **Your own library:** direct RSS / Atom subscriptions, folders, unread filters, stars, and search across downloaded titles and text. Remove subscriptions and restore them with their articles and conversations intact.
- **Move your subscriptions:** import and export OPML with folder membership, duplicate detection, progress, cancellation, and per-feed results.
- **Read with an agent:** summarize a selected article, ask follow-up questions, and see answers as they stream.
- **Conversations that stay with the article:** local history includes a snapshot of the source text used for the conversation.
- **Clear execution states:** running, waiting, completed, failed, and cancelled, with a stop control that preserves partial answers.
- **Keyboard navigation:** move through articles and manage reading state without leaving the keyboard.
- **Terminal and agent harnesses:** a `reedar` CLI lists feeds with unread status, browses and prints articles, and summarizes them through your signed-in agent CLIs; a one-click installer also drops a skill into Claude/Codex/generic agent skill directories so coding agents can call it.

AI requests are explicit and apply to the selected article. AI activity does not change whether you have read an article.

## Getting started

### Requirements

- macOS. Other platforms have not been validated.
- Apple Silicon for the downloadable preview.
- For AI reading, a supported CLI installed and signed in with access to the requested model. Feed reading works without an AI login.

### Install the preview

Download the DMG from the [v0.2.0 release](https://github.com/YunosukeYoshino/reedar/releases/tag/v0.2.0), open it, and drag Reedar into Applications. The ZIP is an alternative containing the same app. Neither Bun nor a source checkout is required. The release includes a SHA-256 manifest and the preview limitations above.

### Run the desktop app

For development, install Bun (the current baseline is **1.4.2**). The test suite also requires `trash` on `PATH` for temporary-file cleanup. From a local checkout:

```sh
bun install --frozen-lockfile
bun run start
```

Installation downloads Electron. The start command builds the renderer and desktop entry point, then opens Reedar. Local DMG and ZIP previews can also be built with `bun run dist:mac --arm64`. Developer ID signed releases are not available yet; see [Distribution](docs/distribution.md).

### App updates (0.2.0 development build)

The desktop app checks the public GitHub releases 30 seconds after launch and every six hours while open. Use **Reedar → アップデートを確認…** to check immediately. This preview receives newer public releases and prereleases for the current Mac architecture; it does not downgrade.

Ad-hoc previews notify you and open the release download page. A Developer ID signed build automatically downloads and validates updates, then offers to restart. Choosing **あとで** keeps the app open and applies the staged update after the next normal quit. Restarting stops active AI responses and OPML imports and saves their current results first. Development runs do not check for updates.

**The published 0.1.2 app has no updater and needs a manual replacement.** A first Developer ID signed version also needs to be installed manually when moving from an ad-hoc preview. Successful signed-app replacement is not yet verified: the project still needs a Developer ID Application certificate and notarization credentials. See [Distribution](docs/distribution.md#app-update-delivery) for the required release assets and signing setup.

### Add your first feed

1. Click **+** in the sidebar and enter an RSS or Atom URL.
2. Select an article to read it. Use the toolbar to star it or mark it unread.
3. Open **Read with AI** (`AIと読む`), choose an agent, and send a question or use the summary shortcut.

Reedar initially displays the text supplied by the feed. Before answering or summarizing, it fetches the linked HTML page and extracts the article text locally. The **要約する** button displays a streamed summary in the main reader; **フィード本文に戻る** restores the feed view. You can inspect the text supplied to the AI beneath the summary.

If retrieval fails or produces less text than the feed, the assistant uses the saved feed text and identifies that limitation. Extraction does not execute JavaScript, use browser cookies, or bypass login/paywalls, and cannot guarantee complete text on every website. Follow-up questions reuse the retrieved source. Ordinary webpage URLs cannot yet be registered as feeds automatically.

## Manage subscriptions

Open **Organize feeds** (`フィードを整理`, the menu beside the sidebar's feed heading) to move or remove a subscription. Removed feeds disappear from reading views and stop refreshing. Their cached articles, stars, and conversations are retained; expand **削除済みのフィード** in the same dialog to restore them. Removing a feed stops its active AI responses and preserves partial text. Folders can be renamed and deleted from the same dialog; deleting a folder moves its feeds to "no folder".

Open **OPML import/export** (`OPML入出力`) at the bottom of the sidebar:

- Select a UTF-8 `.opml` or `.xml` file, then choose **OPMLを読み込む**. Imports support up to 256 KB and 200 feed entries per file.
- Existing subscriptions and duplicate entries are skipped. Removed subscriptions are restored. Valid feeds are saved even when other entries fail; the dialog shows each result and supports cancellation.
- Folder membership is retained. Nested paths become a single folder name such as `Technology / Web`; paths longer than 60 characters fail for that entry. Empty folders are not created during import.
- Choose **OPMLを書き出す** to download the active subscriptions and their folders. This is a subscription export, not a complete library backup: article text, stars, conversations, and removed feeds are excluded.

External OPML inclusions are not followed. DTDs, entities, malformed XML, and private-network feed URLs are rejected. Import progress is available during the current app session; successfully registered subscriptions survive restart.

## Agent support

| Agent | Status | Reading model / behavior |
| --- | --- | --- |
| **Codex** | Verified with a real account | GPT-5.3-Codex-Spark, pinned explicitly; Japanese summaries and follow-up questions verified in the Mac app |
| **Claude Code** | Adapter implemented; live verification pending | Authentication-waiting behavior verified; successful live reading has not been validated |
| **Antigravity** | CLI detection only | Shown as integration pending; article submission is disabled until per-session tool restrictions can be enforced |

Open **Agent connections** (`エージェント接続`) to inspect availability. Sign in through the CLI outside Reedar, then refresh the connection status:

```sh
# Choose the CLI you use:
codex login
claude auth login
```

Codex requires a ChatGPT login and access to `gpt-5.3-codex-spark`. Reedar checks the model returned by the CLI and stops if it differs; it does not silently substitute another model. Claude Code is intended to use an existing subscription login. Requests consume the connected service's usage allowance.

Reedar prefers the Codex CLI bundled with OpenAI’s Codex desktop app, then checks `PATH` and common install locations. You can specify an executable with `REEDAR_CODEX_BIN`, `REEDAR_CLAUDE_BIN`, or `REEDAR_ANTIGRAVITY_BIN`. The Antigravity override affects detection only. Reedar does not rewrite your existing CLI settings.

See the [validation record](docs/validation.md) for tested versions, evidence, and integration limitations.

## Reedar CLI

Choose **CLIとスキルをインストール** in **エージェント接続** to place a `reedar` command at `~/.local/bin/reedar` plus a skill file in `~/.claude/skills/reedar`, `~/.codex/skills/reedar`, and `~/.agents/skills/reedar`. The CLI reads `~/Library/Application Support/Reedar/reader.json` directly (read-only; the app does not need to be running) and supports:

```sh
reedar feeds                              # feeds with unread/star counts
reedar articles --unread --feed hnrss     # newest-first listing
reedar article <id>                       # full article text (prefix ids ok)
reedar summarize <id>                     # summary via your signed-in agent CLI
```

List commands emit JSON Lines, stdout defaults to JSON when piped, and errors go to stderr — the surface is designed for coding agents and `jq` pipelines. `summarize` reuses the app's agent adapter (Codex or Claude login required). Override the library path with `REEDAR_STORE`. Packaged builds ship a compiled binary at `Contents/Resources/bin/reedar`; development installs shim to `bun src/cli/reedar.ts`.

## Keyboard shortcuts

| Shortcut | Action |
| --- | --- |
| `J` / `↓` | Next article |
| `K` / `↑` | Previous article |
| `S` | Toggle star |
| `M` | Toggle read / unread |
| `/` | Focus article search |
| `N` | Add a feed |
| `⌘ Enter` | Send an AI question |

Article shortcuts are inactive while typing in an input field.

## Data and privacy

Your library is stored locally:

| Mode | Default location |
| --- | --- |
| Desktop | `~/Library/Application Support/Reedar/reader.json` |
| Browser development | `.data/dev/reader.json` |

The two modes use separate libraries. Data includes feeds, cached articles, folders, reading state, stars, and conversations. Files are protected by OS permissions and are **not encrypted**. Quit the app before backing up the data directory.

When you send a question, the selected article text and that conversation are sent to the chosen AI provider through its CLI. Local storage does not make model inference local. Feed, article-page, and image retrieval also makes network requests. Desktop update checks contact GitHub; signed builds also download newer application packages.

Reading sessions treat article content as untrusted input, restrict external tools, and reject permission escalation. The renderer sanitizes feed HTML and runs with Electron isolation and a content security policy. A session-authenticated loopback server checks request origins and hosts; network fetching rejects private destinations.

See [Security](SECURITY.md) for the boundaries and their limitations.

## Development

```sh
bun run dev        # Build and start the browser development server
bun run typecheck  # TypeScript checks
bun test           # Automated tests; no live model requests
bun run build      # Renderer and Electron bundles
bun run check      # Typecheck, tests, and build
bun run dist:mac --arm64  # Build a macOS DMG and ZIP preview
bun run checksums  # Write the archive checksum manifest
```

Open the URL printed by `bun run dev`. The server uses a fresh session and an available port on each launch. Keep that URL private. This command does not watch files; restart it after source changes.

Both desktop and browser development accept `REEDAR_DATA_DIR` to choose a separate library directory. Without it, the default locations above apply. Browser development also accepts `REEDAR_PORT` to choose a port. A separate data directory is useful for testing an empty library without changing your normal subscriptions.

The [CI workflow](.github/workflows/ci.yml) runs these checks on pull requests and pushes to `main`, without live model requests. See [GitHub Actions](https://github.com/YunosukeYoshino/reedar/actions) for hosted results.

Built with **Electron, React, TypeScript, and Bun**. Source lives in `src/main` (desktop host and local services), `src/ui` (reader interface), and `src/shared` (validated data contracts). See [Contributing](CONTRIBUTING.md) for the repository map and workflow.

## Scope

This preview focuses on reading a local feed library and discussing individual articles. It does not yet include scheduled refresh, full-library backup/restore, Inoreader or other service sync, mobile clients, automatic digests, or Developer ID signed installers. Large-library performance has not been benchmarked.

The [roadmap checklist](ROADMAP.md) tracks completed work, public-preview preparation, daily-reader improvements, and longer-term candidates.

Normal shutdown preserves partial answers. A crash may lose deltas written since the last save; interrupted responses are marked as failed on the next launch. Corrupt storage produces an error instead of being replaced with an empty library.

## Contributing

Bug reports, focused fixes, and documentation improvements are welcome. Start with the [contribution guide](CONTRIBUTING.md), [design notes](docs/design-notes.md), and [validation record](docs/validation.md).

Reedar is an independent project inspired by Reeder's reading layout. It is not affiliated with Reeder or the connected AI providers.

## License

Reedar is available under the [MIT License](LICENSE). Third-party dependencies retain their own licenses and notices.
