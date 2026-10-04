import { expect, mock, test } from "bun:test";

const firstStarted = Promise.withResolvers<void>();
const nextStarted = Promise.withResolvers<void>();
let navigations = 0;

mock.module("electron", () => ({
  session: {
    fromPartition: () => ({
      setPermissionRequestHandler: () => {},
      webRequest: { onBeforeRequest: () => {} },
      clearStorageData: async () => {},
    }),
  },
  BrowserWindow: class {
    webContents = { setWindowOpenHandler: () => {} };
    loadURL() {
      navigations += 1;
      (navigations === 1 ? firstStarted : nextStarted).resolve();
      return new Promise<void>(() => {});
    }
    destroy() {}
  },
}));

const { renderArticleText } = await import("../src/main/render");

test("queued render cancellation is immediate and preserves serialization", async () => {
  const firstController = new AbortController();
  const queuedController = new AbortController();
  const nextController = new AbortController();
  const reason = new Error("Cancelled in queue");
  const first = renderArticleText("https://example.com/first", firstController.signal).catch((error: unknown) => error);
  await firstStarted.promise;
  const queued = renderArticleText("https://example.com/queued", queuedController.signal).catch((error: unknown) => error);
  const next = renderArticleText("https://example.com/next", nextController.signal).catch((error: unknown) => error);
  try {
    queuedController.abort(reason);
    expect(await Promise.race([queued, Bun.sleep(200).then(() => "still queued")])).toBe(reason);
    await Bun.sleep(10);
    expect(navigations).toBe(1);
    firstController.abort();
    await first;
    await nextStarted.promise;
    expect(navigations).toBe(2);
  } finally {
    firstController.abort();
    queuedController.abort();
    nextController.abort();
    await Promise.all([first, queued, next]);
  }
});
