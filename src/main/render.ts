import { BrowserWindow, session } from "electron";
import type { Session } from "electron";
import { extractArticle } from "./article-text";
import { publicUrl } from "./network";
import { t } from "../shared/i18n";
import type { Language } from "../shared/schema";

const RENDER_TIMEOUT_MS = 20_000;
const RENDER_SETTLE_MS = 1_000;

// ponytail: paywalled and login-required sites stay out of scope — the isolated partition carries no user cookies and the app will not automate around access controls; upgrade path is a consented authenticated session.

let renderSession: Session | undefined;
function renderWindow() {
  if (!renderSession) {
    renderSession = session.fromPartition("render-article");
    renderSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    renderSession.webRequest.onBeforeRequest((details, callback) => {
      // The rendered page runs scripts; keep every request behind the same public-URL boundary as the static fetch.
      try { publicUrl(details.url); callback({}); }
      catch { callback({ cancel: true }); }
    });
  }
  return new BrowserWindow({
    show: false,
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, offscreen: true, session: renderSession },
  });
}

export async function renderArticleText(url: string, signal: AbortSignal, lang: Language = "en") {
  const window = renderWindow();
  try {
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    const combined = AbortSignal.any([signal, AbortSignal.timeout(RENDER_TIMEOUT_MS)]);
    await Promise.race([
      (async () => {
        await window.loadURL(url);
        await new Promise((resolve) => setTimeout(resolve, RENDER_SETTLE_MS));
      })(),
      new Promise<never>((_, reject) => combined.addEventListener("abort", () => reject(new Error(t(lang, "err.timeout"))), { once: true })),
    ]);
    const html = await window.webContents.executeJavaScript("document.documentElement.outerHTML");
    signal.throwIfAborted();
    const finalUrl = window.webContents.getURL() || url;
    const body = extractArticle(String(html), finalUrl, lang);
    return { text: body.text, html: body.html, url: finalUrl };
  } finally {
    window.destroy();
  }
}
