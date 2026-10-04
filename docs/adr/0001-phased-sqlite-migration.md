# Phased SQLite migration for articles

reader.json scales poorly with article count (whole-file parse + serialize on every change) and cannot support full-text search or an event log. We migrate in phases rather than all at once: Phase 1 moves articles and their annotations (note, highlights) into a `node:sqlite` database alongside reader.json; feeds, folders, settings, and conversations stay in JSON until a later phase. `node:sqlite` needs zero new dependencies (built into both Electron's Node 24 and Bun, which also runs the tests and CLI).

On first boot the store imports existing articles from reader.json, then renames it `reader.json.bak`. If the database cannot be opened or validated, the app falls back to degraded mode (JSON only, no search) rather than refusing to start — local-first means never losing the user's library to a storage bug.

Phase 1 also creates the FTS5 index over title, summary, and readerText (global, cross-feed search; the existing `/` filter stays feed-scoped) and an empty `events` table — event recording ships later and stays opt-in.
