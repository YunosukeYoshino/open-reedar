# save-to-instapaper

Action plugin that saves the current article's URL to Instapaper via the
documented Simple API (`POST https://www.instapaper.com/api/add` with HTTP
Basic auth).

## Install

1. Export your Instapaper credentials so `save.sh` can read them:
   `export INSTAPAPER_USERNAME=... INSTAPAPER_PASSWORD=...` (the script
   inherits your normal user environment when Reedar runs it).
2. Make the script executable: `chmod +x save.sh`
3. Copy this directory into Reedar's plugin directory:
   `~/Library/Application Support/Reedar/plugins/save-to-instapaper/`
   (or `$REEDAR_DATA_DIR/plugins/` in development).
4. In Reedar, run `plugins.refresh` (or restart), open an article, and use
   the "Send to" toolbar menu.

The plugin receives the article as JSON on stdin — the same shape as
`open-reedar article --json`. It prints a confirmation line on stdout, which
Reedar shows as a notice in the reader. On failure (non-zero exit) Reedar
shows the script's stderr instead.
