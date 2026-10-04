# Validation record

Last verified: **September 12, 2026 (JST)**. Environment: macOS, Bun 1.4.2, Electron 42.11.1. This record describes observed behavior, not a promise of compatibility with every account or future CLI release. Earlier checks retain their original scope below; see the [roadmap](../ROADMAP.md) for outstanding work.

## Automated checks

`bun run check` passed TypeScript checking, **66 tests with 216 assertions**, and the renderer and Electron builds. The dated sections below record the feature-specific additions.

The suite covers:

- RSS / Atom parsing, stable article identity, and HTML sanitization.
- Rejection of private network destinations and unsafe URLs.
- Session authentication, Origin / Host checks, malformed launch credentials, and split UTF-8 input.
- Persistence, concurrent saves, corrupt storage, and interrupted responses.
- Conversation history, authentication waiting, cancellation, and late output after cancellation.
- CLI request routing, timeouts, streaming, sandbox parameters, and rejection of model substitution.
- Antigravity detection without execution and rejection of reading requests before any provider is launched.
- Desktop asset resolution and keyboard navigation without intercepting text input.

Tests use fixtures and local child processes; they do not make live model requests.

React Doctor reported no errors. The full UI scan scored 84/100 with maintainability warnings around conditional rendering, state, and array iteration. A later scan of seven changed files scored 87/100, with four existing warnings about Zod APIs and chained iteration. Scores from different scopes are not directly comparable. The warnings were retained where inspection found no concrete regression.

## Manual RSS and library checks

These public feeds were added through the application form:

| Feed | URL | Articles at the time of validation |
| --- | --- | --- |
| Zenn trends | https://zenn.dev/feed | 20 |
| Publickey | https://www.publickey1.jp/atom.xml | 15 |
| Hacker News front page | https://hnrss.org/frontpage | 20 |

The 55-article library was used to verify folder creation, moving feeds between folders, reading article bodies, unread counts, starring, and `J` navigation after selecting an article. These actions were performed through the UI rather than by editing storage.

## Codex

Live checks used the app-bundled **Codex CLI 0.153.4** and an existing ChatGPT login. The source was a Publickey article about the .NET 11 release candidate.

Initial checks confirmed:

1. A Japanese summary, a source link, and the completed state.
2. A follow-up answer distinguishing information in the supplied body from information present only in the title.
3. Incremental output during a longer answer, followed by cancellation and preservation of the partial text.

The feed supplied an excerpt. The response acknowledged the incomplete source rather than claiming the entire article had been retrieved.

### GPT-5.3-Codex-Spark

After pinning the model, the CLI's `model/list` response confirmed availability of `gpt-5.3-codex-spark` and support for medium reasoning effort. Reedar specifies the model in both `thread/start` and `turn/start`, then checks the model returned at thread creation. Automated coverage verifies that substitution is rejected.

In the Mac app, a request for a three-point Japanese summary completed with the **Codex · Spark** label. A follow-up asking for more detail about the third point also completed, referencing the previous answer and separating supplied facts from missing details. Both included the source link.

Completed Spark responses and their model labels remained in local storage after normal shutdown and restart. Older responses without recorded model metadata retained the generic Codex label. The cancellation check above preceded the Spark-specific checks; it is not a separate live Spark cancellation result.

## Claude Code

CLI detection, the login-required connection state, and an authentication-waiting reading request were verified. The test machine did not have a usable existing Claude Code login.

**Successful live summarization, follow-up questions, and streaming remain unverified.** Further live checks were deferred. Adapter implementation and authentication-state checks do not establish successful end-to-end support.

## Antigravity

The application detects the installed `agy` CLI and displays **integration pending**. Automated checks verify that reading requests fail explicitly and cannot fall through to Codex.

During a separate compatibility investigation, `agy models` returned a model list using the existing login. No article content was supplied to the headless initialization probes. In an isolated temporary workspace, a custom agent was tested with `tools: []` and `tools: [finish]`; the second probe also used `--mode plan`.

Both initialization responses still listed filesystem, command, browser, and MCP tools, and reported `permission_mode: always-proceed`. The probes therefore did not establish the required isolation. No global permission or plugin settings were changed, and article execution remains disabled in Reedar.

The [headless documentation](https://antigravity.google/docs/cli/headless/) and [permission documentation](https://antigravity.google/docs/cli/permissions/), reviewed on the verification date, describe use of existing permissions and default workspace read/write access. The [SDK](https://antigravity.google/docs/sdk/overview/) provides tool restrictions but requires Gemini API-key or Vertex authentication, so it was not adopted for the existing-CLI-login path.

The unresolved requirement is a supported connection method that reuses the existing login while enforcing per-session restrictions on external actions. **Antigravity summaries and follow-up questions are neither implemented nor verified.**

## Desktop lifecycle and recovery

The library initially created through the browser UI was copied into an empty desktop data directory for desktop verification. The desktop and browser modes do not otherwise synchronize their libraries.

Manual shutdown and restart checks preserved articles, folders, unread state, stars, completed answers, and cancelled partial answers. A desktop asset-resolution failure found during the first run was fixed after adding a failing build regression test. The final restart also showed Codex as connected and Antigravity as integration pending.

## Remaining limits

- Article extraction is available on explicit AI requests; JavaScript-only, blocked, authenticated, and paywalled pages may fall back to feed text.
- CLI and account compatibility can change and must be revalidated.
- Large feed libraries and very long histories have not been performance-tested.
- A crash can lose unsaved response deltas; normal stop and shutdown preserve partial output.
- Signed installers, notarization, mobile clients, and subscription-service sync have not been validated or shipped.

Return to the [README](../README.md) or [contribution guide](../CONTRIBUTING.md).

## macOS preview packaging

On September 11, 2026, electron-builder 26.15.3 produced Apple Silicon `.app`, DMG, and ZIP previews for version 0.1.0 using Electron 42.11.1. The package metadata points to `icon.icns`; the generated icon and version appeared in the packaged app's About panel during a native Mac UI check.

After normally quitting the development app, the packaged app launched successfully and displayed the existing library and conversation count. Its connection dialog reported Codex connected, Claude Code requiring login, and Antigravity pending. Packaging verification did not issue additional live model requests.

`codesign --verify --deep --strict` passed for the ad-hoc-signed bundle. DMG verification and ZIP integrity checks passed. The SHA-256 manifest was generated and verified. The ASAR root contained only `dist`, `node_modules`, and `package.json`; checks found no local data, Git directory, source/test tree, or release outputs. Electron and Chromium license notices were present in `Contents/Resources/licenses/`.

The automated suite remained at 37 passing tests, with type checking and builds passing. The manually triggered GitHub Actions workflow parsed successfully and has read-only repository contents permission; it has not run on GitHub. Intel execution, Developer ID signing, notarization, and downloaded-app Gatekeeper approval on another Mac remain unverified. See [Distribution](distribution.md) for commands and release requirements.


## Linked article text and inline summaries — September 12, 2026

Version 0.1.1 retrieves the linked HTML article before explicit AI requests. Readability extracts the article using an inert Linkedom DOM; the initial feed display remains available. Retrieval failures use a marked feed fallback, and successful retrieval is retained for follow-up questions. Legacy conversations retain their original excerpt snapshot when upgraded.

The automated suite passed **45 tests / 139 assertions**, with type checking and renderer/desktop builds passing. Added coverage checks article opening and final paragraphs, removal of navigation/scripts, source reuse, marked retrieval failure, cancellation during retrieval, legacy-source preservation, empty-source failure, inline summary rendering, safe Markdown, and returning to the feed view without a second model request. React Doctor scored 84/100 for the changed UI with no errors; remaining warnings concern component control-flow complexity and existing state/iteration patterns.

A live packaged-app check used the Publickey article about .NET 11 RC1. Its feed text contained **242 characters**; the extracted linked article contained **2,139 characters**, including the final WebAssembly/CoreCLR section and release-timing paragraph. The extracted endpoint was compared with the public page. The app upgraded the existing Codex conversation, retained the 242-character original source, and completed a GPT-5.3-Codex-Spark summary in the main article pane. The answer included JIT, AOT, and WebAssembly content absent from the excerpt. The UI showed the 2,139-character source, expanded the supplied text, returned to the feed excerpt, and reopened the saved summary without another model run. The existing library remained available after the update.

Extraction remains best effort: blocked, authenticated, paywalled, non-HTML, and JavaScript-only pages may not yield an article. Text is not silently truncated to fit the model; the existing 180,000-character prompt limit fails explicitly. Automated tests cover fallback and cancellation; the live model check covered the successful Codex path.

The Apple Silicon 0.1.1 app, DMG, and ZIP were rebuilt locally. Distribution remains an ad-hoc signed, unnotarized preview; no GitHub publication was performed.

## Subscription management and OPML — September 12, 2026

Version 0.1.2 adds subscription removal/restoration and OPML import/export. The suite passed **58 tests / 186 assertions**, including preservation of removed-feed data, removal during refresh, import duplicates and partial failures, import cancellation, XML limits, external-inclusion rejection, authenticated export, large import requests, and invalid UTF-8 file selection. Type checking and both builds passed. React Doctor scored 100/100 with no findings for the six files in the OPML UI change; this is a scoped scan, not a new full-application score. `bun audit` returned no reported vulnerabilities.

The packaged app was copied outside the source checkout and launched on the same Apple Silicon Mac with an empty library using `REEDAR_DATA_DIR`. Native UI checks confirmed:

- Registering Publickey's Atom URL retrieved 15 articles. Reading and starring an article left 14 unread and one star.
- Removing the feed hid its articles; restoring it recovered all 15 articles, the unread count, and the star.
- Selecting an OPML file through the macOS file picker imported Zenn into `Import test`. The four-entry file produced one registration, two duplicate skips, and one private-network URL rejection.
- Exporting through the native save dialog produced an OPML file that parsed back to both active subscriptions and the expected folder membership, without article or conversation data.
- Normal shutdown and restart preserved two feeds, 35 articles, 34 unread, one star, and the imported folder.

The updated app was then reopened with the ordinary library and displayed the existing three feeds, 78 articles, 42 unread, one star, and six conversations. This was an isolated-library check on the development Mac, not installation on a second Mac. No additional live AI request was issued. A machine without an installed CLI, downloaded-app Gatekeeper behavior, and a fresh installation on another Mac remain unverified.

The Apple Silicon 0.1.2 app, DMG, and ZIP include the project's MIT license. Bundle signature verification, DMG verification, ZIP integrity, and SHA-256 manifest verification passed. Signing remains ad-hoc and the preview is not notarized. These checks preceded publication and used local artifacts.

## First public prerelease — September 12, 2026

Source was published to [YunosukeYoshino/open-reedar](https://github.com/YunosukeYoshino/open-reedar). The first hosted [CI run](https://github.com/YunosukeYoshino/open-reedar/actions/runs/34631456205) passed at commit `acfd815a51525054a977ca51566f9db8a631156a`, using a clean macOS runner to install dependencies, typecheck, run the test suite, and build the renderer and desktop host. This does not replace the outstanding second-Mac installation check. The [v0.1.2 release notes](https://github.com/YunosukeYoshino/open-reedar/releases/tag/v0.1.2) record the final source revision, archive provenance, and download limitations.

The release tag points to `1e4eae9d5dff579f0f528e139c4a41893569a042`. Its [CI run](https://github.com/YunosukeYoshino/open-reedar/actions/runs/34631597749) and [macOS packaging run](https://github.com/YunosukeYoshino/open-reedar/actions/runs/34631631014) both passed, including 58 tests / 186 assertions. The workflow's Apple Silicon archives were downloaded and passed SHA-256, DMG verification, and ZIP integrity checks. The extracted app reported version 0.1.2 and arm64 architecture, passed strict bundle signature verification, and contained the matching MIT license. GitHub's uploaded asset sizes and SHA-256 digests matched the downloaded artifacts and manifest before publication. The release is published as a prerelease with three assets: DMG, ZIP, and `SHA256SUMS.txt`. It remains ad-hoc signed and unnotarized; these checks do not constitute a new live UI or second-Mac installation test of the hosted build.

## Desktop updates — September 12, 2026

The unreleased 0.1.3 build adds a native update menu, startup/periodic checks, preview download-page notifications, and automatic download/staging for Developer ID signed builds. The automated suite passed **66 tests / 216 assertions**. Added coverage checks architecture/version selection, ignored drafts and unsafe release links, notification deduplication, waiting for download validation, confirmation before restart, persistence failure, signature/download failure, concurrent checks, late shutdown results, offline/manual checks, and downgrade rejection. These tests use a simulated updater; they do not install a real signed update. Type checking and both builds passed, and `bun audit` reported no vulnerabilities.

The local Apple Silicon 0.1.3 bundle launched with the existing 78 articles and six conversations. **Reedar → アップデートを確認…** queried the public repository and displayed that 0.1.3 had no newer compatible release; the public version was still 0.1.2. The dialog closed normally. Its ad-hoc signature passed strict bundle verification, but was not treated as a Developer ID signature, so no installer was downloaded or run.

Packaging produced `app-update.yml` with the fixed public repository and `latest-mac.yml` beside the archives. Both archive sizes and SHA-512 hashes matched update metadata; DMG verification, ZIP integrity, and the SHA-256 manifest passed. The signed profile was exercised with identity discovery disabled and failed as required instead of producing an unsigned update. The modified workflow parsed locally but has not run on GitHub.

The machine has no Developer ID Application identity. A signed/notarized package, native signature rejection against real update archives, immediate restart installation, and installation on normal quit therefore remain unverified. Do not infer successful end-to-end self-updating from the simulated tests. The first updater-enabled app and the first Developer ID signed app each require manual installation for users upgrading from the existing ad-hoc 0.1.2 release.

## Apple Intelligence agent — September 29, 2026

The `apple` agent runs through the macOS 27 `fm` command-line tool (`fm respond`). This Mac runs macOS 26.5.2 in a VM: `fm` is absent and Foundation Models reports `deviceNotEligible`, so no real on-device request was made. Detection, prompt sizing, instructions injection, UTF-8 chunk decoding, timeout/abort handling, and the empty-response path are covered by automated tests using `REEDAR_APPLE_BIN` shims (96 tests / 326 assertions). **Behavior against the real `fm` binary — exit codes, streaming granularity, and model availability when Apple Intelligence is disabled — remains unverified on hardware.** Run a live summary once on a Mac with Apple Intelligence enabled.

## Integrated PR review — October 4, 2026

The integration review covers map-reduce, library management, benchmarks, ADRs, streamed checkpoints, SQLite/FTS5, rendered fallback, Apple PCC, and the reader toggle/next cue. Regression tests cover degraded SQLite edits and deletions through restart/recovery, restore races with late feed additions, active-answer retention, and cloud notices on CLI stderr without corrupting JSON stdout.

Apple routing, PCC escalation/fallback, digest prompt budgets, and condensation are tested with fake `fm` executables and injected runners. No actual Apple Intelligence or Private Cloud Compute request was made: the VM still reports `deviceNotEligible`. These automated checks do not establish real model availability, output quality, or cloud behavior.
