#!/bin/sh
# Reedar action plugin: saves the current article to Instapaper.
# Receives the article JSON on stdin (same shape as `open-reedar article --json`).
# Uses Instapaper's documented Simple API: POST https://www.instapaper.com/api/add
# with HTTP Basic auth (your account username and password).
# Export INSTAPAPER_USERNAME and INSTAPAPER_PASSWORD before installing.
set -e

if [ -z "$INSTAPAPER_USERNAME" ] || [ -z "$INSTAPAPER_PASSWORD" ]; then
  echo "INSTAPAPER_USERNAME and INSTAPAPER_PASSWORD are not set" >&2
  exit 1
fi

json="$(cat)"
if command -v jq >/dev/null 2>&1; then
  url="$(printf '%s' "$json" | jq -r .url)"
  title="$(printf '%s' "$json" | jq -r .title)"
else
  url="$(printf '%s' "$json" | python3 -c 'import json,sys; print(json.load(sys.stdin)["url"])')"
  title="$(printf '%s' "$json" | python3 -c 'import json,sys; print(json.load(sys.stdin)["title"])')"
fi

curl -fsS -u "$INSTAPAPER_USERNAME:$INSTAPAPER_PASSWORD" \
  "https://www.instapaper.com/api/add" \
  --data-urlencode "url=$url" \
  --data-urlencode "title=$title"

echo "Saved: $title"
