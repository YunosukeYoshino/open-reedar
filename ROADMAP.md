# Roadmap

Current development baseline: **0.1.3 (unreleased)**, September 12, 2026. Reedar runs locally on macOS with verified Codex reading and locally built Apple Silicon previews. The first public prerelease is [v0.1.2](https://github.com/YunosukeYoshino/open-reedar/releases/tag/v0.1.2).

Checked items are implemented and validated within the scope stated. Unchecked items are proposed work, not release-date commitments. The sections below have separate completion criteria: daily-reader improvements and additional providers do not all need to ship before a first public preview.

## Recommended minimum scope

Automatic PR checks are configured. Complete **a fresh installation on another Apple Silicon Mac** to extend validation beyond the development machine. The license and preview limitations are documented in the public repository and prerelease. Other reader features can follow a clearly labeled early preview.

Subscription removal/restoration and OPML import/export are now implemented. Folder cleanup can follow. Automatic refresh is the next convenience improvement; service sync and more providers can wait. Desktop update checking is implemented; automatic installation awaits signed release validation.

The detailed checkboxes below remain the source of status for these priorities.

## Available now

- [x] Three-pane reader with direct RSS / Atom subscriptions and manual refresh.
- [x] Folder creation, renaming, and feed organization; unread state, stars, local search, and keyboard navigation.
- [x] Local library and conversation persistence across normal app restarts.
- [x] Linked-page article extraction before AI requests, with an explicit feed-text fallback.
- [x] Streamed summaries in the main reader, a return-to-feed control, and inspection of the supplied source text.
- [x] Codex / GPT-5.3-Codex-Spark summaries and follow-up conversations using an existing CLI login.
- [x] Explicit execution states, cancellation, source snapshots, and restricted reading sessions.
- [x] App icon, local Apple Silicon DMG / ZIP packaging, and checksums; ad-hoc signing only.
- [x] English project and contribution documentation, issue / PR templates, and a manual packaging workflow definition.
- [x] Local automated checks: 66 tests / 216 assertions, type checking, and desktop / renderer builds.

Evidence and provider-specific limits: [Validation](docs/validation.md).

## First public preview — make the project available

The repository and first downloadable preview are public. Installation on another Mac remains the outstanding validation step.

- [x] **Choose the source license.** MIT license added with matching project metadata and packaging configuration.
- [x] **State preview limitations.** README and distribution notes identify Apple Silicon / Codex verification, ad-hoc signing, missing notarization, and unverified installation on another Mac.
- [x] **Publish the repository.** Source is available at [YunosukeYoshino/open-reedar](https://github.com/YunosukeYoshino/open-reedar).
- [x] **Run checks on pull requests.** Automatic typecheck, test, and build CI is configured for pull requests and pushes to main. Hosted results are available in [GitHub Actions](https://github.com/YunosukeYoshino/open-reedar/actions).
- [x] **Validate hosted packaging.** The macOS workflow passed for v0.1.2. Downloaded archives passed SHA-256, DMG, ZIP, and extracted-app signature verification.
- [x] **Publish a tagged preview.** The v0.1.2 prerelease includes DMG, ZIP, checksums, features, architecture, signing status, and supported-agent limitations.
- [ ] **Document a fresh installation.** Test on another Apple Silicon Mac with no source checkout, including reading without a CLI and connecting a supported CLI; add a short, non-personal screenshot or demo to the README.

See [Distribution](docs/distribution.md) for the build procedure and [v0.1.2](https://github.com/YunosukeYoshino/open-reedar/releases/tag/v0.1.2) for the published artifacts and limitations.

## Daily reading — proposed next product work

Prioritize moving an existing feed library into Reedar and managing it without editing local JSON.

- [x] **Remove and restore subscriptions.** Removed feeds stop refreshing and disappear from reading views; cached articles, stars, and conversations are retained for restoration.
- [ ] **Remove folders.** Define where their subscriptions move, with an undo or recovery flow.
- [x] **Import and export OPML.** Preserve folder membership, skip duplicates, report individual failures, and support cancellation. Nested folder paths are flattened; the import limit is 256 KB / 200 feeds.
- [ ] **Refresh feeds automatically while the app is open.** Add a configurable interval, retry/backoff, and conditional requests so repeated refreshes do not download unchanged feeds unnecessarily.
- [ ] **Mark a feed or folder as read.** Add scoped bulk actions with a clear target and undo.
- [ ] **Discover feeds from website URLs.** Offer RSS / Atom candidates when a user enters a normal site URL; retain the existing public-network checks.
- [ ] **Manage and back up local data.** Export and restore a library, remove individual conversations, and define cache retention without discarding starred articles or their conversation sources.

## Reliability and AI reading

- [ ] **Broaden article-extraction coverage.** Add representative fixtures and live checks for additional sites, short articles, encodings, and partial extraction. Login and paywall bypass are outside this work.
- [ ] **Handle long articles and conversations.** Provide a deliberate continuation or segmentation flow with visible source coverage. The current 180,000-character prompt limit rejects oversized requests explicitly.
- [ ] **Checkpoint streamed answers during a run.** Recover more recent partial output after a crash; normal cancellation and shutdown already save it.
- [ ] **Measure larger libraries.** Benchmark refresh, search, scrolling, and persistence with thousands of articles, then fix demonstrated bottlenecks.
- [ ] **Validate keyboard and assistive-technology use.** Check focus, dialogs, source disclosures, and streamed status announcements with VoiceOver and the minimum supported window size.
- [ ] **Verify Claude Code end to end.** The adapter exists; successful live summaries, follow-ups, streaming, and cancellation still need a usable subscription login and recorded results.
- [ ] **Resolve Antigravity's reading boundary.** Establish an existing-login connection that enforces per-session tool restrictions before implementing or enabling article execution. Current CLI detection does not establish reading support.

Provider work can progress independently. Neither Claude verification nor Antigravity support blocks a Codex-only preview when its scope is stated accurately.

## Broader macOS distribution

- [ ] **Sign and notarize releases.** Configure Developer ID signing, Hardened Runtime and required entitlements, notarization, and stapling; validate the downloaded app with Gatekeeper on another Mac. The current preview uses ad-hoc signing.
- [ ] **Validate Intel support if it will be advertised.** The packaging configuration accepts `x64`, but Intel execution has not been tested. An Apple Silicon-only release is a valid initial scope.
- [x] **Check for app updates.** Packaged apps check GitHub automatically and from the Mac menu. Ad-hoc previews link to the download page.
- [ ] **Validate automatic installation.** The updater, metadata, and signed-build configuration are implemented. Verify the complete upgrade between two Developer ID signed and notarized releases before claiming end-to-end support.

## Later candidates — not required for the first release

- [ ] English UI and selectable summary language.
- [ ] Reading preferences such as font size and appearance, plus saved agent preferences.
- [ ] Dedicated translation, highlighting, notes, and conversation export.
- [ ] Multi-article comparisons and explicitly enabled digests.
- [ ] Subscription-service sync, other desktop platforms, or mobile clients, after choosing a supported scope.

## Keeping this checklist useful

For implementation work, create a focused issue with acceptance criteria, link its PR here, and check the item only after the relevant tests and manual verification pass. Keep [Validation](docs/validation.md) aligned with claims of live provider and release support. No issue or PR links are present yet because this checkout has no configured remote.
