# save-to-instapaper

Action plugin that saves the current article's URL to Instapaper via the
documented Simple API (`POST https://www.instapaper.com/api/add` with HTTP
Basic auth).

## Install

1. Export your Instapaper credentials so `save.sh` can read them:
   `export INSTAPAPER_USERNAME=... INSTAPAPER_PASSWORD=...` (the script
   inherits your normal user environment when Reedar runs it).
2. In Reedar's sidebar, click `+` in the Plugins section and pick this
   folder. Uploading installs and rescans in one step, and restores the
   executable bit on the script the manifest names.
3. Open an article and use the "Send to" toolbar menu.

Manual install also works: `chmod +x save.sh`, copy this directory into
`~/Library/Application Support/Reedar/plugins/save-to-instapaper/` (or
`$REEDAR_DATA_DIR/plugins/` in development), then run `plugins.refresh`
or restart.

The plugin receives the article as JSON on stdin — the same shape as
`open-reedar article --json`. It prints a confirmation line on stdout, which
Reedar shows as a notice in the reader. On failure (non-zero exit) Reedar
shows the script's stderr instead.
