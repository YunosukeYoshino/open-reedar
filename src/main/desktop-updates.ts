import { app, autoUpdater as nativeUpdater, dialog, Menu, shell } from "electron";
import type { BrowserWindow, MenuItemConstructorOptions, MessageBoxOptions } from "electron";
import electronUpdater from "electron-updater";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { AppUpdates, newestRelease } from "./updates";
import type { UpdateNotice } from "./updates";
import { fetchPublic } from "./network";

const releasePage = "https://github.com/YunosukeYoshino/open-reedar/releases";
const exec = promisify(execFile);

async function supportsAutomaticInstall() {
  try {
    // Developer ID is required; an ad-hoc or Apple Development identity is not a distribution identity.
    await exec("/usr/bin/codesign", ["--verify", "--deep", "--strict", "-R", "anchor apple generic and certificate leaf[field.1.2.840.113635.100.6.1.13] exists", resolve(process.execPath, "../../..")], { timeout: 10_000, maxBuffer: 64 * 1024 });
    return true;
  } catch { return false; }
}

function noticeOptions(notice: UpdateNotice): MessageBoxOptions {
  const base = { title: "Reedarのアップデート", type: "info" as const, noLink: true };
  switch (notice.kind) {
    case "available": return { ...base, message: `Reedar ${notice.version} が利用できます`, detail: "このプレビュー版は自動インストールに対応していません。リリースページから新版をダウンロードして入れ替えてください。記事と会話は引き継がれます。", buttons: ["ダウンロードページを開く", "あとで"], defaultId: 0, cancelId: 1 };
    case "ready": return { ...base, message: `Reedar ${notice.version} の準備ができました`, detail: "再起動して更新できます。実行中のAI応答とOPMLの取り込みは停止して保存します。「あとで」を選ぶと、次にアプリを終了したあとに更新が適用されます。", buttons: ["再起動して更新", "あとで"], defaultId: 1, cancelId: 1 };
    case "current": return { ...base, message: `Reedar ${notice.version} は最新です`, detail: "このMac向けの新しい公開版・プレリリースはありません。", buttons: ["OK"] };
    case "development": return { ...base, message: "アップデートは配布版で利用できます", detail: "開発中のアプリは自動更新しません。", buttons: ["OK"] };
    case "error": return { ...base, type: "error", message: notice.stage === "check" ? "アップデートを確認できませんでした" : notice.stage === "download" ? "更新ファイルを取得・検証できませんでした" : "更新を適用できませんでした", detail: "時間をおいて再度お試しください。リリースページから手動でダウンロードすることもできます。", buttons: ["リリースページを開く", "閉じる"], defaultId: 1, cancelId: 1 };
  }
}

export async function createDesktopUpdates(window: BrowserWindow, prepareToInstall: () => Promise<void>) {
  const lifetime = new AbortController();
  const packagedMac = app.isPackaged && process.platform === "darwin";
  const automatic = packagedMac && await supportsAutomaticInstall();
  const updater = automatic ? electronUpdater.autoUpdater : null;
  let cancellation: InstanceType<typeof electronUpdater.CancellationToken> | undefined;

  if (updater) {
    updater.logger = null;
    updater.autoDownload = false;
    updater.autoInstallOnAppQuit = true;
    updater.allowPrerelease = true;
    updater.channel = "latest";
    updater.allowDowngrade = false;
    // Rejections are handled by check/download promises. Keep late native errors from becoming uncaught events.
    updater.on("error", () => {});
  }

  const openRelease = (version?: string) => shell.openExternal(version ? `${releasePage}/tag/v${encodeURIComponent(version)}` : releasePage);
  const updates = new AppUpdates({
    version: app.getVersion(),
    delivery: packagedMac ? {
      kind: automatic ? "automatic" : "manual",
      check: async () => {
        if (updater) {
          const result = await updater.checkForUpdates();
          return result?.isUpdateAvailable ? result.updateInfo.version : null;
        }
        const response = await fetchPublic("https://api.github.com/repos/YunosukeYoshino/open-reedar/releases?per_page=100", 0, lifetime.signal);
        return newestRelease(JSON.parse(response.body.toString("utf8")) as unknown, app.getVersion(), process.arch);
      },
      download: async (progress) => {
        if (!updater) throw new Error("Automatic installation is unavailable");
        lifetime.signal.throwIfAborted();
        const staged = new AbortController();
        const stop = () => staged.abort();
        lifetime.signal.addEventListener("abort", stop, { once: true });
        cancellation = new electronUpdater.CancellationToken();
        const onProgress = (info: { percent: number }) => progress(info.percent);
        updater.on("download-progress", onProgress);
        try {
          // electron-updater's event precedes Squirrel validation. Do not offer restart until native staging succeeds.
          await Promise.all([once(nativeUpdater, "update-downloaded", { signal: staged.signal }), updater.downloadUpdate(cancellation)]);
        } finally {
          staged.abort();
          lifetime.signal.removeEventListener("abort", stop);
          updater.removeListener("download-progress", onProgress);
          cancellation = undefined;
        }
      },
      install: () => {
        if (!updater) throw new Error("Automatic installation is unavailable");
        updater.quitAndInstall();
      },
      dispose: () => { lifetime.abort(); cancellation?.cancel(); },
    } : null,
    notice: async (notice) => {
      if (window.isDestroyed()) return false;
      try {
        const result = await dialog.showMessageBox(window, noticeOptions(notice));
        if (notice.kind === "error" && result.response === 0) { await openRelease(); return false; }
        return ["available", "ready"].includes(notice.kind) && result.response === 0;
      } catch { return false; }
    },
    openRelease,
    prepareToInstall,
    changed: () => {
      const item = Menu.getApplicationMenu()?.getMenuItemById("check-updates");
      const state = updates.state;
      if (item) {
        item.enabled = !updates.busy;
        item.label = state.kind === "checking" ? "アップデートを確認中…" : state.kind === "downloading" ? `更新をダウンロード中… ${Math.floor(state.percent)}%` : state.kind === "installing" ? "更新を適用中…" : state.kind === "ready" ? `再起動して ${state.version} に更新…` : state.kind === "available" ? `${state.version} をダウンロード…` : "アップデートを確認…";
      }
      if (!window.isDestroyed()) window.setProgressBar(state.kind === "downloading" ? state.percent / 100 : -1);
    },
  });
  const menuItem: MenuItemConstructorOptions = { id: "check-updates", label: "アップデートを確認…", click: () => { void updates.check(true); } };
  return { menuItem, start: () => updates.start(), dispose: () => updates.dispose() };
}
