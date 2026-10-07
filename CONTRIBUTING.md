# Contributing to Reedar

Reedar is an early macOS RSS reader with article-focused AI conversations. Contributions should keep reading fast, preserve local data, and make each agent's actual capabilities clear.

Start with the [roadmap](ROADMAP.md) for proposed work and its completion criteria. Unchecked items describe outstanding work; they are not all requirements for the first public preview.

## Set up a development environment

Use macOS, Bun, and the `trash` command. The validated baseline is Bun 1.4.2 and Electron 42.11.1. Tests use `trash` to remove temporary fixtures.

From your checkout:

```sh
bun install --frozen-lockfile
bun run check
bun run start
```

Use `bun run dev` for browser development. It builds once and prints a session-authenticated local URL; restart after changes. Desktop and browser development use separate data directories, described in the [README](README.md#data-and-privacy).

You do not need a model subscription to run the automated suite. Live AI checks require your own authenticated CLI and consume its usage allowance.

## Find your way around

| Path | Responsibility |
| --- | --- |
| `src/main/electron.ts` | Mac window, lifecycle, and navigation policy |
| `src/main/server.ts` | Authenticated loopback HTTP server and event stream |
| `src/main/engine.ts` | Library actions, agent jobs, cancellation, and state updates |
| `src/main/store.ts` | Local JSON persistence and recovery |
| `src/main/feeds.ts`, `src/main/network.ts` | RSS / Atom parsing, HTML sanitization, and safe network fetching |
| `src/main/updates.ts`, `src/main/desktop-updates.ts` | Update state, GitHub release checks, Mac dialogs, and signed-app staging |
| `src/main/opml.ts` | Bounded OPML parsing and subscription export |
| `src/main/agents/` | CLI discovery, process lifecycle, authentication, and reading adapters |
| `src/shared/schema.ts` | Zod contracts shared by the host and renderer |
| `src/ui/` | React reader interface and styles |
| `scripts/build.ts` | Browser and Electron builds |
| `scripts/icons.ts`, `assets/` | App icon and macOS icon conversion |
| `electron-builder.json`, `electron-builder.signed.cjs` | Preview packaging, update metadata, and the optional signed/notarized profile |
| `.github/workflows/ci.yml` | Automatic pull-request and main-branch checks |
| `.github/workflows/build-macos.yml` | Manually triggered preview artifact builds |
| `.conveyor/` | Merge policy, eval contract, and gate for the `auto`-labeled auto-merge lane |
| `tests/` | Protocol, storage, network, workflow, desktop, and UI tests |
| `docs/` | Design context and validation evidence |

## Make a focused change

1. Read the relevant code and tests before editing. Follow the existing structure and style.
2. Keep each change scoped to a concrete problem. Discuss large features in an issue before implementation.
3. For a bug, add a failing regression test first, then fix the behavior. Prefer tests at observable boundaries over tests that repeat the implementation.
4. Run `bun run check`. For UI or live CLI changes, also perform the relevant manual checks below.
5. Update documentation when setup, behavior, compatibility, or limitations change.
6. Commit logical changes separately using Conventional Commits, such as `fix: preserve a cancelled response` or `docs: clarify agent setup`.

Use Bun for package management. Commit `bun.lock` when dependencies change. Keep generated bundles, local libraries, credentials, and personal CLI configuration out of version control. Use `trash` for file deletion.

Keep `private: true` in `package.json`: this desktop application is not intended for accidental npm publication.

## Before opening a pull request

Explain the problem, the resulting behavior, and how you verified it. State any checks you could not run. For visual changes, include a screenshot with personal feed content and private details removed. Avoid mixing unrelated refactors into a fix.

For changes to reading or persistence, verify the affected flow in the Mac app:

- Add a public RSS or Atom feed, open an article, and exercise the relevant folder, unread, or star actions.
- Quit and reopen the app to check that the affected state survives.
- Check keyboard navigation and input fields when changing interaction behavior.

For an agent adapter, verify with a real supported CLI when possible:

- Summarize a public article, ask a follow-up, and observe streaming and completion.
- Stop a response and confirm partial text is retained.
- Verify authentication failures, unavailable models, and permission requests remain explicit.
- Confirm the adapter cannot fall through to another provider or silently change the requested model.

Automated protocol fixtures do not establish live provider compatibility. Describe unverified integrations as unverified. See the [validation record](docs/validation.md) for the current evidence.

## Preserve the reading boundary

Articles and conversation history are untrusted data. A feed must not grant an agent filesystem, command, browser, or other external-tool access. Do not introduce permission-bypass flags or modify a user's global CLI settings to make an integration work.

Keep AI execution separate from human reading state. Keep a conversation's source snapshot stable when a feed refreshes. Never include credentials or private launch URLs in issues, logs, test fixtures, or model input.

Report security concerns using [SECURITY.md](SECURITY.md).

## Build a distributable app

See [macOS distribution](docs/distribution.md) for DMG / ZIP builds, checksums, the manual GitHub Actions workflow, and the distinction between preview builds and notarized Developer ID releases. Packaging does not publish anything automatically.
