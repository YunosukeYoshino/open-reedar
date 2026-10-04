# Rendered-fetch fallback for article extraction

Extraction today is a static fetch plus Readability; JS-heavy sites return near-empty pages and fall back to the feed's own summary. We add a second extraction attempt only when the static result is too thin: load the URL in an offscreen Electron BrowserWindow, wait for render, then run the same Readability pipeline on the resulting DOM. Electron is already a dependency, so this adds no new package and no headless-browser install.

Paywalled and login-required sites are deliberately out of scope — the app will not automate around access controls, and a `ponytail:` comment marks that ceiling. Fetching stays lazy (on reader-view click); no prefetching, which keeps bandwidth use and tracking surface aligned with the local-first stance.
