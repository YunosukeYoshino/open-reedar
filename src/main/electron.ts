import { app, BrowserWindow, Menu, shell, dialog } from "electron";
import { join, resolve } from "node:path";
import { startServer } from "./server";
import { renderArticleText } from "./render";
import { publicUrl } from "./network";
import { createDesktopUpdates } from "./desktop-updates";
import { t } from "../shared/i18n";
import type { Language } from "../shared/schema";

app.setName("Reedar");
let runtime: Awaited<ReturnType<typeof startServer>> | undefined;
let quitting = false;
let updates: Awaited<ReturnType<typeof createDesktopUpdates>> | undefined;
let closing: Promise<void> | undefined;

const language = (): Language => runtime?.engine.store.state.language ?? "en";

function buildMenu() {
  const lang = language();
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: "Reedar", submenu: [{ role: "about" }, updates!.menuItem(), { type: "separator" }, { role: "hide" }, { role: "hideOthers" }, { type: "separator" }, { role: "quit" }] },
    { label: t(lang, "menu.edit"), submenu: [{ role: "undo" }, { role: "redo" }, { type: "separator" }, { role: "cut" }, { role: "copy" }, { role: "paste" }, { role: "selectAll" }] },
    { label: t(lang, "menu.view"), submenu: [{ role: "reload" }, { role: "togglefullscreen" }, { role: "resetZoom" }, { role: "zoomIn" }, { role: "zoomOut" }] },
    { label: t(lang, "menu.window"), submenu: [{ role: "minimize" }, { role: "zoom" }] },
  ]));
}

function closeRuntime() { return closing ??= runtime?.close() ?? Promise.resolve(); }

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", () => {
    const window = BrowserWindow.getAllWindows()[0];
    if (window?.isMinimized()) window.restore();
    window?.focus();
  });
  void app.whenReady().then(async () => {
    if (!app.isPackaged) app.dock?.setIcon(join(app.getAppPath(), "dist", "icon.png"));
    runtime = await startServer({ dataDirectory: resolve(process.env.REEDAR_DATA_DIR || join(app.getPath("appData"), "Reedar")), staticDirectory: join(app.getAppPath(), "dist", "web"), renderArticleText });
    const window = new BrowserWindow({
      title: "Reedar", width: 1380, height: 900, minWidth: 920, minHeight: 620,
      backgroundColor: "#1b1c21", titleBarStyle: "hiddenInset", trafficLightPosition: { x: 18, y: 18 },
      webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
    });
    window.on("closed", () => {
      // Hidden render windows must not keep the app alive once the visible UI is gone.
      if (BrowserWindow.getAllWindows().every((win) => !win.isVisible())) app.quit();
    });
    window.webContents.setWindowOpenHandler(({ url }) => {
      try { void shell.openExternal(publicUrl(url).href); } catch { /* Never open non-web schemes. */ }
      return { action: "deny" };
    });
    window.webContents.on("will-navigate", (event, url) => {
      if (runtime && new URL(url).origin === runtime.origin) return;
      event.preventDefault();
      try { void shell.openExternal(publicUrl(url).href); } catch { /* Keep untrusted schemes out of the host. */ }
    });
    // Plugin iframes may only navigate inside the app origin; a panel must never
    // redirect itself to an external page where it could exfiltrate article data.
    window.webContents.on("will-frame-navigate", (event) => {
      if (event.isMainFrame || !runtime) return;
      try { if (new URL(event.url).origin === runtime.origin) return; } catch { /* Non-URL navigation is also blocked. */ }
      event.preventDefault();
    });
    window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    updates = await createDesktopUpdates(window, async () => {
      await closeRuntime();
      quitting = true;
    }, language);
    buildMenu();
    let menuLanguage = language();
    runtime.engine.subscribe((update) => {
      if (update.type === "snapshot" && update.snapshot.state.language !== menuLanguage) { menuLanguage = update.snapshot.state.language; buildMenu(); }
    });
    await window.loadURL(runtime.url);
    updates.start();
  }).catch((error: unknown) => {
    dialog.showErrorBox(t(language(), "err.launchFailed"), error instanceof Error ? error.message : t(language(), "err.launchError"));
    app.quit();
  });
  app.on("window-all-closed", () => app.quit());
  app.on("before-quit", (event) => {
    updates?.dispose();
    if (!runtime || quitting) return;
    event.preventDefault(); quitting = true;
    void closeRuntime().finally(() => app.quit());
  });
}
