# Open Reedar

Domain language for the open-reedar RSS reader: a local-first macOS app that aggregates feeds, extracts article content, and summarizes it with CLI-based AI agents.

## Language

### Reading

**Feed**:
A subscribed RSS/Atom source identified by its XML URL. Discovered feeds are candidate URLs found by scanning a website's HTML before subscription.
_Avoid_: channel, subscription source

**Folder**:
A named grouping of feeds shown in the sidebar.
_Avoid_: category, tag, collection

**Article**:
A single entry from a feed, with read/starred state, optional note, highlights, and extracted content.
_Avoid_: post, item, entry

**Library**:
The whole persisted dataset: feeds, folders, articles, conversations, and settings. Historically a single reader.json; articles migrate to SQLite in phases.
_Avoid_: database, store, archive

**Article content**:
The extracted readable form of an article's linked page. `readerHtml` is the sanitized markup; `readerText` is its plain-text form used for search and AI prompts.
_Avoid_: reader mode (that is the view), full text, body

**Reader view**:
The UI mode that renders article content instead of the feed-provided summary.
_Avoid_: reader mode (ambiguous with the whole app), distilled view

**Rendered fetch**:
Article extraction via an offscreen Electron page load, used as a fallback when static fetching produces too little text.
_Avoid_: headless scrape, browser fetch

**Digest**:
A single synthesized summary produced from multiple selected articles by an agent.
_Avoid_: briefing, roundup

**Retention**:
The age limit after which unread, unstarred, unannotated articles are dropped. 0 means keep forever.
_Avoid_: expiration, TTL, pruning

### Conversations and agents

**Conversation**:
A saved Q&A thread attached to an article (reader) or the library (organizer), holding messages and its producing agent.
_Avoid_: chat, session (reserved for app/agent processes)

**Agent**:
An external AI executable invoked through the CLI runner: codex, claude, or apple (the macOS `fm` CLI).
_Avoid_: provider, model, bot

**System tier**:
The on-device Apple Foundation Model reached via `fm` without `--model`. Roughly 8K token context.
_Avoid_: local model, on-device (when naming the tier)

**PCC tier**:
The Private Cloud Compute Apple Foundation Model reached via `fm --model pcc`. Larger (~32K context), cloud-processed, usage-limited.
_Avoid_: cloud model, server model

**Partial answer**:
Streamed agent output preserved when a run aborts or fails mid-stream, marked so the UI can flag it as incomplete.
_Avoid_: truncated answer, draft

**Condense**:
The map-reduce stage that shrinks article text to fit an agent's context budget: chunk, summarize each chunk, concatenate.
_Avoid_: compress, shrink, summarize (ambiguous with the user-facing summary)

### Storage and runtime

**Snapshot**:
The serialized view of engine state sent to the renderer; every Action produces a new Snapshot.
_Avoid_: state dump, sync payload

**Events**:
The opt-in log of reading signals (open, mark-read, star) recorded for future preference/profile features. Off by default.
_Avoid_: history, analytics, activity log

**Degraded mode**:
Running with reader.json only when the SQLite store fails to open or validate. The app stays usable; search and DB-backed features are unavailable.
_Avoid_: fallback mode, safe mode, recovery mode
