import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/main/store";
import type { Article, Feed } from "../src/shared/schema";

const directory = await mkdtemp(join(tmpdir(), "reedar-store-test-"));
afterAll(async () => { await Bun.spawn(["trash", directory]).exited; });
const feed: Feed = { id: "feed", url: "https://example.com/rss", title: "Example", siteUrl: "https://example.com", folderId: null, updatedAt: null, error: null };
const article: Article = {
  id: "article", feedId: "feed", title: "An article", url: "https://example.com/article", author: "",
  publishedAt: "2026-09-10T00:00:00.000Z", receivedAt: "2026-09-11T00:00:00.000Z", html: "<p>Original</p>",
  text: "Original", excerpt: "Original", imageUrl: null, read: false, starred: false,
};

describe("reader persistence", () => {
  test("refresh preserves read and starred state, older missing entries and the conversation snapshot", async () => {
    const path = join(directory, "refresh.json");
    const store = await Store.open(path);
    store.mergeFeed(feed, [article, { ...article, id: "old" }]);
    store.article("article").read = true;
    store.article("article").starred = true;
    store.article("article").readerHtml = "<p>Reader</p>";
    store.article("article").readerText = "Reader";
    store.state.conversations.push({ id: "conversation", articleId: "article", agent: "codex", source: { title: article.title, url: article.url, text: article.text, capturedAt: article.receivedAt }, messages: [] });
    store.mergeFeed({ ...feed, title: "Renamed" }, [{ ...article, text: "Updated" }]);
    await store.save();
    const reopened = await Store.open(path);
    expect(reopened.article("article")).toMatchObject({ read: true, starred: true, text: "Updated", readerHtml: "<p>Reader</p>", readerText: "Reader" });
    expect(reopened.article("old").text).toBe("Original");
    expect(reopened.state.conversations[0]?.source.text).toBe("Original");
    expect(reopened.state.feeds[0]?.title).toBe("Renamed");
  });

  test("refresh drops reader content when the article URL changes", async () => {
    const store = await Store.open(join(directory, "url-change.json"));
    store.mergeFeed(feed, [{ ...article, readerHtml: "<p>Old</p>", readerText: "Old" }]);
    store.mergeFeed(feed, [{ ...article, url: "https://example.com/article-v2", readerHtml: undefined, readerText: undefined }]);
    const updated = store.article("article");
    expect(updated.url).toBe("https://example.com/article-v2");
    expect(updated.readerHtml).toBeUndefined();
    expect(updated.readerText).toBeUndefined();
  });

  test("a restart marks unfinished output as interrupted and preserves partial output", async () => {
    const path = join(directory, "restart.json");
    const store = await Store.open(path);
    store.state.conversations.push({ id: "c", articleId: "a", agent: "claude", source: { title: "Article", url: "https://example.com", text: "Body", capturedAt: "now" }, messages: [{ id: "m", role: "assistant", text: "Partial", createdAt: "now", state: { status: "running" } }] });
    await store.save();
    const reopened = await Store.open(path);
    const message = reopened.state.conversations[0]?.messages[0];
    expect(message?.text).toBe("Partial");
    expect(message?.role === "assistant" && message.state.status).toBe("failed");
  });

  test("corrupt storage is never replaced with empty state", async () => {
    const path = join(directory, "corrupt.json");
    await writeFile(path, "{corrupt");
    await expect(Store.open(path)).rejects.toThrow("original file was kept");
    expect(await readFile(path, "utf8")).toBe("{corrupt");
  });

  test("concurrent saves finish in order and folders survive restart", async () => {
    const path = join(directory, "ordered.json");
    const store = await Store.open(path);
    store.saveFolder(null, "Technology");
    const first = store.save();
    store.saveFolder(null, "Design");
    const second = store.save();
    await Promise.all([first, second]);
    expect((await Store.open(path)).state.folders.map((folder) => folder.name)).toEqual(["Technology", "Design"]);
    expect(() => store.saveFolder(null, "Design")).toThrow();
    expect(() => store.folder("missing")).toThrow();
  });
});
