# Security

Reedar handles untrusted feed content and launches local agent CLIs. The current preview is designed for one user on a local Mac; it is not a hosted or multi-user service.

## Report a vulnerability

If this repository offers GitHub's **Report a vulnerability** option under its Security tab, use it for a private report. Otherwise, open a minimal issue asking for a private contact channel. Keep exploit details, credentials, personal feed content, and private launch URLs out of public issues.

A useful private report includes the affected commit, macOS and CLI versions, reproduction steps using a harmless fixture, expected versus actual behavior, and the impact. There is no guaranteed response time or maintained security backport schedule for this preview.

## Security boundaries

- **Article rendering:** feed HTML is sanitized before display. The Electron renderer disables Node integration and uses context isolation, sandboxing, and a content security policy.
- **Network access:** feed, article-page, and image requests reject local and private destinations, including resolved addresses and redirects. Images are retrieved through a constrained local proxy. Static article extraction uses an inert DOM, executes no page scripts, and sends no browser cookies. Static retrieval is limited to 5 MB with a 25-second overall network deadline; extracted text is treated as untrusted input.
- **Rendered extraction:** desktop reader requests may fall back when static extraction fails or contains fewer than 500 characters. The offscreen Electron page executes site scripts in a sandbox without Node integration, denies permissions and popups, uses a separate nonpersistent session, and clears its storage afterward. Renders run serially so cookies cannot overlap between articles. Every page and subresource request validates the public URL and resolved addresses; Chromium owns the final connection, so resistance to DNS changes between validation and connection is unverified. A 20-second deadline covers navigation, settling, and DOM extraction; the hidden window is destroyed on completion or failure. The static 5 MB limit does not bound the total rendered page's subresources. Paywalls and authenticated pages are unsupported.
- **OPML:** imports reject DTDs and entity declarations, parse strict XML, and bound file size, outline depth, and feed count. External OPML inclusions are not fetched. Feed retrieval uses the existing public-network checks. Exports require the local authenticated session and contain active subscription URLs and folder names.
- **App updates:** the main process checks the fixed public `YunosukeYoshino/reedar` GitHub repository. Update controls are in the native Mac menu, not exposed to feed HTML or renderer IPC. Ad-hoc and Apple Development signed builds can only notify and open the fixed release page. Developer ID signed builds use electron-updater checksums and Squirrel.Mac signature validation; restart is offered only after native staging succeeds. Automatic checks include prereleases, never downgrade, and do not send library contents.
- **Local server:** the host binds to loopback and uses a per-launch authenticated session. Host and Origin checks reject unexpected callers. The printed launch URL is a credential and must remain private.
- **Agent execution:** the application supplies the selected article and conversation as quoted, untrusted data. Supported reading adapters restrict tools and reject permission escalation. Authentication stays with the installed CLI; Reedar does not copy tokens into model prompts or rewrite global CLI settings.
- **Antigravity:** installation detection is available, but article execution is disabled. The tested CLI did not enforce the required per-session tool restrictions.

These controls do not make arbitrary future CLI versions safe automatically. Changes to a provider's protocol, tool defaults, or configuration loading require fresh validation. See the [validation record](docs/validation.md) for what has actually been tested.

## Data handling and limitations

Library files are local SQLite and JSON protected by OS permissions, not encryption. They contain cached article text, annotations, conversation history, and a migration backup. Removing a subscription hides it and stops updates; retained data remains on disk subject to article retention. OPML export contains subscriptions only; library export contains articles and reading settings but excludes conversations. Restore re-sanitizes article HTML and replaces library data. Backups should receive the same protection as the original files.

Selected article text and conversation history leave the Mac when you ask a cloud-backed CLI to answer. Apple `system` uses the on-device model; `pcc`, automatic escalation of oversized prompts, Apple digests, and Apple condensation send content to Private Cloud Compute and show a localized notice (stderr in the CLI). Provider account settings, retention, and service terms apply to that processing. Feed, article-page, and image requests also contact external hosts. Retrieved article text is stored in the local conversation snapshot.

Reedar does not protect against a compromised OS account, a malicious replacement CLI executable, or other software running with equivalent access. Only point executable overrides at CLIs you trust. Do not expose the local server through a public interface or tunnel.
