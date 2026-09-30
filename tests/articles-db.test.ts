import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { connection } from "../src/main/agents/reader";
import { ArticlesDb } from "../src/main/articles-db";
import { Engine } from "../src/main/engine";
import { Store } from "../src/main/store";
import { stateSchema } from "../src/shared/schema";
import type { Article, Feed, ReaderState } from "../src/shared/schema";

const directory = await mkdtemp(join(tmpdir(), "reedar-db-test-"));
afterAll(async () => { await Bun.spawn(["trash", directory]).exited; });

const feed: Feed = { id: "feed", url: "https://example.com/rss", title: "Example", siteUrl: "https://example.com", folderId: null, updatedAt: null, error: null };
const otherFeed: Feed = { ...feed, id: "other", url: "https://other.example.com/rss", title: "Other" };
const article: Article = {
  id: "article", feedId: "feed", title: "An article about keyboard mods", url: "https://example.com/article", author: "",
  publishedAt: "2026-09-10T00:00:00.000Z", receivedAt: "2026-09-11T00:00:00.000Z", html: "<p>Original</p>",
  text: "Original", excerpt: "Original", imageUrl: null, read: false, starred: false,
};
const library = (articles: Article[]): ReaderState => ({ version: 1, folders: [], feeds: [feed], articles, conversations: [], language: "en", refreshMinutes: 30, fontSize: "m" });
const connect: typeof connection = async (agent) => ({ agent, installed: true, status: "ready", detail: "fixture" });

describe("articles database", () => {
  test("first boot imports reader.json articles into the database and keeps a .bak of the original", async () => {
    const dir = join(directory, "migrate");
    await mkdir(dir, { recursive: true });
    const path = join(dir, "reader.json");
    await writeFile(path, JSON.stringify(library([{ ...article, read: true, starred: true, note: "Keep", highlights: ["line"], readerHtml: "<p>R</p>", readerText: "Reader" }])));
    const store = await Store.open(path);
    expect(store.searchAvailable).toBe(true);
    expect(store.article("article")).toMatchObject({ read: true, starred: true, note: "Keep", highlights: ["line"], readerText: "Reader" });
    const migrated = stateSchema.parse(JSON.parse(await readFile(path, "utf8")));
    expect(migrated.articles).toEqual([]);
    expect(migrated.feeds).toHaveLength(1);
    const backup = stateSchema.parse(JSON.parse(await readFile(`${path}.bak`, "utf8")));
    expect(backup.articles).toHaveLength(1);
    store.article("article").note = "Updated";
    await store.save();
    const reopened = await Store.open(path);
    expect(reopened.article("article").note).toBe("Updated");
    expect(stateSchema.parse(JSON.parse(await readFile(path, "utf8"))).articles).toEqual([]);
    store.close();
    reopened.close();
  });

  test("a corrupt database falls back to JSON-only mode and reports search unavailable", async () => {
    const dir = join(directory, "corrupt");
    await mkdir(dir, { recursive: true });
    const path = join(dir, "reader.json");
    await writeFile(path, JSON.stringify(library([article])));
    await writeFile(join(dir, "articles.db"), "GARBAGE-NOT-SQLITE");
    const store = await Store.open(path);
    expect(store.searchAvailable).toBe(false);
    expect(store.article("article").title).toBe("An article about keyboard mods");
    expect(store.searchArticles("keyboards")).toBeNull();
    store.article("article").read = true;
    await store.save();
    expect(stateSchema.parse(JSON.parse(await readFile(path, "utf8"))).articles[0]?.read).toBe(true);
    const engine = new Engine(store, join(dir, "runner"), { connect });
    await engine.dispatch({ type: "articles.search", query: "keyboards" });
    expect(engine.snapshot.search).toMatchObject({ query: "keyboards", results: [], unavailable: true });
    await engine.close();
  });

  test("full-text search matches title, feed text, and reader text across feeds", () => {
    const db = ArticlesDb.open(":memory:");
    db.write([
      article,
      { ...article, id: "b", feedId: "other", title: "Unrelated", readerText: "A keyboard review" },
      { ...article, id: "c", feedId: "other", title: "Also unrelated", text: "different" },
    ]);
    const results = db.search("keyboard");
    expect(results.map((match) => match.id).sort()).toEqual(["article", "b"]);
    expect(results.find((match) => match.id === "b")?.feedId).toBe("other");
    expect(db.search("keyboard article").map((match) => match.id)).toEqual(["article"]);
    db.close();
  });

  test("merge keeps stored annotations and reader state over fresh feed content", () => {
    const db = ArticlesDb.open(":memory:");
    db.write([{ ...article, read: true, starred: true, note: "N", highlights: ["H"], readerHtml: "<p>R</p>", readerText: "R" }]);
    db.merge([{ ...article, text: "Fresh", read: false, starred: false }]);
    expect(db.get("article")).toMatchObject({ text: "Fresh", read: true, starred: true, note: "N", highlights: ["H"], readerText: "R" });
    db.merge([{ ...article, id: "new", note: "Fresh note" }]);
    expect(db.get("new")).toMatchObject({ note: "Fresh note" });
    db.close();
  });

  test("a URL change drops stored reader content and write removes missing ids", () => {
    const db = ArticlesDb.open(":memory:");
    db.write([{ ...article, readerText: "Old" }]);
    db.merge([{ ...article, url: "https://example.com/v2" }]);
    expect(db.get("article")?.readerText).toBeUndefined();
    db.write([], ["article"]);
    expect(db.get("article")).toBeUndefined();
    expect(db.search("keyboard")).toEqual([]);
    db.close();
  });

  test("articles.search returns cross-feed matches with feed context in the snapshot", async () => {
    const dir = join(directory, "engine");
    const store = await Store.open(join(dir, "reader.json"));
    store.mergeFeed(feed, [article]);
    store.mergeFeed(otherFeed, [{ ...article, id: "x", feedId: "other", title: "Keyboard shortcuts" }]);
    await store.save();
    const engine = new Engine(store, join(dir, "runner"), { connect });
    await engine.initialize();
    await engine.dispatch({ type: "articles.search", query: "keyboard" });
    expect(engine.snapshot.searchAvailable).toBe(true);
    expect(engine.snapshot.search).toMatchObject({ query: "keyboard" });
    expect(engine.snapshot.search?.results.map((match) => match.id).sort()).toEqual(["article", "x"]);
    expect(engine.snapshot.search?.results.find((match) => match.id === "x")?.feedId).toBe("other");
    await engine.dispatch({ type: "articles.searchClear" });
    expect(engine.snapshot.search).toBeNull();
    await engine.close();
  });

  test("upserts fire the FTS triggers so stale terms do not resurface on reused rows", () => {
    const db = ArticlesDb.open(":memory:");
    db.write([{ ...article, title: "oldterm article" }]);
    db.write([{ ...article, title: "newterm article" }]);
    db.write([], ["article"]);
    db.write([{ ...article, id: "b", title: "innocent" }]);
    expect(db.search("oldterm")).toEqual([]);
    expect(db.search("innocent").map((match) => match.id)).toEqual(["b"]);
    db.close();
  });

  test("a failed database open restores articles from the migration backup", async () => {
    const dir = join(directory, "restore-bak");
    await mkdir(dir, { recursive: true });
    const path = join(dir, "reader.json");
    await writeFile(path, JSON.stringify(library([])));
    await writeFile(`${path}.bak`, JSON.stringify(library([article])));
    await writeFile(join(dir, "articles.db"), "GARBAGE-NOT-SQLITE");
    const store = await Store.open(path);
    expect(store.searchAvailable).toBe(false);
    expect(store.article("article").title).toContain("keyboard");
    store.close();
  });

  test("an open search refreshes when new matching articles arrive", async () => {
    const dir = join(directory, "search-refresh");
    const store = await Store.open(join(dir, "reader.json"));
    const engine = new Engine(store, join(dir, "runner"), { connect });
    await engine.initialize();
    await engine.dispatch({ type: "articles.search", query: "keyboard" });
    expect(engine.snapshot.search?.results).toEqual([]);
    store.mergeFeed(feed, [article]);
    await store.save();
    await engine.dispatch({ type: "article.read", id: article.id, read: true });
    expect(engine.snapshot.search?.results.map((match) => match.id)).toEqual(["article"]);
    await engine.close();
  });
});
