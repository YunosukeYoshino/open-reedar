import { BrowserWindow, session } from "electron";
import type { Session } from "electron";
import { extractArticle } from "./article-text";
import { isPublicAddress, publicUrl } from "./network";
import { t } from "../shared/i18n";
import type { Language } from "../shared/schema";

const RENDER_TIMEOUT_MS = 20_000;
const SETTLE_BUDGET_MS = 8_000;
const SETTLE_POLL_MS = 400;

// ponytail: paywalled and login-required sites stay out of scope — the isolated partition carries no user cookies and the app will not automate around access controls; upgrade path is a consented authenticated session.

let renderSession: Session | undefined;
// ponytail: serialize hidden renders to isolate cookies in the shared partition; use per-request sessions for parallel rendering.
let rendering: Promise<void> = Promise.resolve();
function renderWindow() {
  if (!renderSession) {
    const partition = session.fromPartition("render-article");
    renderSession = partition;
    partition.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    partition.webRequest.onBeforeRequest((details, callback) => {
      // The rendered page runs scripts; keep every request behind the same public-URL boundary as the static fetch, and check what the host actually resolves to before issuing it.
      let url: URL;
      try { url = publicUrl(details.url); }
      catch { return callback({ cancel: true }); }
      partition.resolveHost(url.hostname.replace(/^\[|\]$/g, ""))
        .then(({ endpoints }) => callback(endpoints.length > 0 && endpoints.every((endpoint) => isPublicAddress(endpoint.address)) ? {} : { cancel: true }))
        .catch(() => callback({ cancel: true }));
    });
  }
  return new BrowserWindow({
    show: false,
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, offscreen: true, session: renderSession },
  });
}

export async function renderArticleText(url: string, signal: AbortSignal, lang: Language = "en") {
  const previous = rendering;
  const released = Promise.withResolvers<void>();
  rendering = released.promise;
  try {
    await previous;
    signal.throwIfAborted();
    return await renderArticle(url, signal, lang);
  } finally {
    released.resolve();
  }
}

async function renderArticle(url: string, signal: AbortSignal, lang: Language) {
  const window = renderWindow();
  const partition = renderSession!;
  const combined = AbortSignal.any([signal, AbortSignal.timeout(RENDER_TIMEOUT_MS)]);
  // One deadline covers the whole render: navigation, settling, DOM read, and extraction.
  const race = async <T>(work: Promise<T>) => {
    combined.throwIfAborted();
    return Promise.race([work, new Promise<never>((_, reject) => combined.addEventListener("abort", () => reject(new Error(t(lang, "err.timeout"))), { once: true }))]);
  };
  try {
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    await race(window.loadURL(url));
    // Sites that inject article text after load get a settle budget: poll body text until it stops growing for two consecutive checks.
    let length = -1;
    let stable = 0;
    for (const deadline = Date.now() + SETTLE_BUDGET_MS; Date.now() < deadline && stable < 2;) {
      const next = await race(window.webContents.executeJavaScript("document.body?.innerText?.length ?? 0")) as number;
      stable = next === length ? stable + 1 : 0;
      length = next;
      if (stable < 2) await race(new Promise((resolve) => setTimeout(resolve, SETTLE_POLL_MS)));
    }
    const html = await race(window.webContents.executeJavaScript("document.documentElement.outerHTML"));
    signal.throwIfAborted();
    const finalUrl = window.webContents.getURL() || url;
    const body = extractArticle(String(html), finalUrl, lang);
    return { text: body.text, html: body.html, url: finalUrl };
  } finally {
    window.destroy();
    // Cookies and cache from one rendered site must not follow into the next article's render.
    await partition.clearStorageData().catch(() => {});
  }
}
