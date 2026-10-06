# Reedar plugins

Plugins extend Reedar with local files: a `plugin.toml` manifest plus the
files the plugin needs. There is no build step and no registry — a plugin is
just a directory.

## Installing

Copy the plugin directory into Reedar's plugin directory, then rescan:

- Packaged app: `~/Library/Application Support/Reedar/plugins/<name>/`
- Development: `$REEDAR_DATA_DIR/plugins/<name>/` (default `.data/dev/plugins/<name>/` when `REEDAR_DATA_DIR` is unset)

Plugins load at startup and after the `plugins.refresh` action. Plugins with
errors appear in the registry with `status: "error"` and never abort the
scan; there is no filesystem watching in v1.

## Manifest

`plugin.toml` lives at the root of the plugin directory:

```toml
name = "word-count"
title = "Word Count"              # optional, shown in the UI
type = "panel"                    # "panel" or "action"
entry = "index.html"              # panel only, default "index.html"
placement = "sidebar"             # panel only: "sidebar" (default) or "article"
command = ["./save.sh"]           # action only, required: argv array
permissions = ["articles.read", "dispatch", "net:api.instapaper.com"]
```

- `name` must match the directory name: `[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}`.
- `type` is a discriminated union: `action` requires a non-empty `command`
  array; `panel` allows `entry` and `placement`.
- `entry` is a relative path inside the plugin directory; `..` and absolute
  paths are rejected.
- `placement`: `sidebar` panels appear in the sidebar's Plugins section and
  render in the main pane; `article` panels render in a collapsible section
  under the article, next to notes and highlights.

## Trust model

The two plugin types have deliberately different trust levels.

**Action plugins** are trusted local executables, like git external
commands. `plugin.invoke` runs `command` with the plugin directory as the
working directory and your normal user environment — credentials in files
under the plugin directory or in exported environment variables are
available to the process. Reedar writes the article JSON (the same shape as
`open-reedar article --json`) to stdin, caps stdout/stderr at 64 KB each,
and kills the process group after 30 seconds. The reader shows the
process's stdout on success and its stderr on a non-zero exit. Only install
action plugins you trust with your user account.

**Panel plugins** are untrusted content. They render in a sandboxed
`<iframe sandbox="allow-scripts">` served by Reedar's local server from
`/plugins/<name>/<file>`. They get an opaque origin: no Node APIs, no app
DOM access, no `localStorage`, no cookies, and no filesystem paths.
Everything a panel needs must either ship inside its own directory or come
through the postMessage bridge. The served document also carries a CSP
`sandbox allow-scripts` directive, so opening the same URL top-level keeps
the panel in an opaque origin instead of gaining the app's session and API
access. Per-plugin CSP additionally restricts what
the document may load: scripts, styles, and images only from the plugin's
own files (`'unsafe-inline'` for scripts and styles, so a single-file
`index.html` works), and network access limited to the
hosts declared as `net:<hostname>` permissions plus the app's own
origin. In the packaged app the frame is also pinned to the app origin: a
panel cannot navigate itself to an external page, so article data cannot
leave through a redirect.

## Bridge protocol

Panels talk to Reedar over `postMessage`. A plugin posts
`{ id, method, params }` to its parent; the parent answers `{ id, result }`
or `{ id, error }`. Replies are matched by `id`. The parent verifies
`event.source === iframe.contentWindow` (sandboxed frames have a `null`
origin, so source identity is the check) and validates every message.

Methods:

| Method | Params | Result |
| --- | --- | --- |
| `ready` | — | Parent posts `{ type: "init", state }` to the panel. `state` is `{ article, feeds, folders }` with real data when `articles.read` is permitted, empty otherwise. Re-posted when the selected article changes. |
| `getState` | — | `{ article, feeds, folders }`; requires `articles.read`. |
| `getArticle` | `{ id }` | The full article object; requires `articles.read`. |
| `dispatch` | an app action object | The action's result, forwarded through the app's action channel; requires `dispatch`. Any `actionSchema` action may be dispatched. |

Unknown methods, malformed messages, and unpermitted calls answer
`{ id, error }`.

## Permissions

- `articles.read` — `getState`, `getArticle`, and non-empty `init` state.
- `dispatch` — forward app actions (e.g. mark read, star) through `dispatch`.
  This grants the full action surface, including `plugin.invoke` and
  `plugins.refresh`, so treat it as trusted-panel access.
- `net:<hostname>` — adds the host to the panel document's `connect-src`.

Permissions do not widen the sandbox; a panel without `articles.read` still
renders, it just receives empty state.

## Examples

- `examples/plugins/word-count/` — a sidebar panel that renders the current
  article's word count and reading time via `ready`/`getArticle`.
- `examples/plugins/save-to-instapaper/` — an action plugin that reads the
  article JSON on stdin and saves it to Instapaper with `curl`.
