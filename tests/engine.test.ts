import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthenticationRequired } from "../src/main/agents/reader";
import type { condenseText, connection, runOrganizer, runReader } from "../src/main/agents/reader";
import { Engine } from "../src/main/engine";
import { parseFeed } from "../src/main/feeds";
import { Store } from "../src/main/store";
import type { Article, LibraryExport } from "../src/shared/schema";

const directory = await mkdtemp(join(tmpdir(), "reedar-engine-test-"));
afterAll(async () => { await Bun.spawn(["trash", directory]).exited; });
const xml = `<rss version="2.0"><channel><title>Test</title><link>https://example.com</link><item><guid>article</guid><title>Article</title><link>https://example.com/a</link><description>Evidence in the article.</description></item></channel></rss>`;

async function setup(name: string, run: typeof runReader, failRefresh = false, fetchArticleText = async (_url: string, _signal: AbortSignal) => ({ text: "Evidence in the article.", html: "<p>Evidence in the article.</p>", url: "https://example.com/a" }), organize: typeof runOrganizer = async () => {}, condense: typeof condenseText = async () => { throw new Error("condense not stubbed"); }) {
  const path = join(directory, name, "state.json");
  const store = await Store.open(path);
  const result = await parseFeed(xml, "https://example.com/rss", null);
  store.mergeFeed(result.feed, result.articles);
  const connect: typeof connection = async (agent) => ({ agent, installed: true, status: "ready", detail: "fixture" });
  const dependencies = {
    run, connect, fetchArticleText, organize, condense,
    fetchFeed: async (url: string, folderId: string | null) => { if (failRefresh) throw new Error("Network failed"); return parseFeed(xml, url, folderId); },
  };
  const engine = new Engine(store, join(directory, name, "runner"), dependencies);
  await engine.initialize();
  const article = store.state.articles[0];
  if (!article) throw new Error("fixture missing");
  return { engine, store, article, path };
}

describe("reading workflow", () => {
  test("library restore discards a feed addition started before replacement", async () => {
    const { store, engine } = await setup("restore-feed-add", async () => {});
    const backup = await engine.dispatch({ type: "library.export" }) as LibraryExport;
    backup.feeds = []; backup.articles = [];
    const pending = Promise.withResolvers<Awaited<ReturnType<typeof parseFeed>>>();
    const fetching = Promise.withResolvers<void>();
    const lateEngine = new Engine(store, join(directory, "restore-feed-add", "runner"), {
      fetchFeed: async () => { fetching.resolve(); return pending.promise; },
    });
    const adding = lateEngine.dispatch({ type: "feed.add", url: "https://example.com/late", folderId: null });
    await fetching.promise;
    await lateEngine.dispatch({ type: "library.import", json: JSON.stringify(backup) });
    pending.resolve(await parseFeed(xml, "https://example.com/late", null));
    await adding;
    expect(store.state.feeds).toEqual([]);
    expect(store.state.articles).toEqual([]);
    await engine.close();
  });

  test("retention preserves an article and conversation while an answer is running", async () => {
    const pending = Promise.withResolvers<void>();
    const answering = Promise.withResolvers<void>();
    const { engine, store, article } = await setup("retention-active", async (_agent, _conversation, _question, _cwd, signal, emit) => {
      answering.resolve();
      await pending.promise;
      expect(signal.aborted).toBe(false);
      emit({ type: "delta", text: "Kept response" });
    });
    article.publishedAt = "2020-01-01T00:00:00Z";
    await engine.dispatch({ type: "chat.send", articleId: article.id, agent: "codex", text: "Hi" });
    await answering.promise;
    await engine.dispatch({ type: "app.setArticlesRetention", days: 30 });
    expect(store.state.articles).toHaveLength(1);
    expect(store.state.conversations).toHaveLength(1);
    pending.resolve(); await engine.settle();
    expect(store.state.conversations[0]?.messages.at(-1)).toMatchObject({ text: "Kept response", state: { status: "completed" } });
    await engine.close();
  });

  test("AI reading leaves human unread state unchanged and passes previous completed history to follow-up", async () => {
    const contexts: number[] = [];
    const { engine, store, article, path } = await setup("conversation", async (_agent, conversation, _question, _cwd, _signal, emit) => {
      contexts.push(conversation.messages.length);
      emit({ type: "delta", text: "First" });
      emit({ type: "delta", text: "First answer" });
    });
    await engine.dispatch({ type: "chat.send", articleId: article.id, agent: "codex", text: "Summarize" });
    await engine.settle();
    await engine.dispatch({ type: "chat.send", articleId: article.id, agent: "codex", text: "Why?" });
    await engine.settle();
    expect(contexts).toEqual([0, 2]);
    expect(article.read).toBe(false);
    expect(store.state.conversations[0]?.messages.at(-1)).toMatchObject({ role: "assistant", text: "First answer", state: { status: "completed" } });
    expect((await Store.open(path)).state.conversations[0]?.messages).toHaveLength(4);
    await engine.close();
  });

  test("fetches the linked article before AI reading and reuses the complete source on follow-up", async () => {
    const source = "Opening paragraph. " + "Detailed evidence missing from the RSS excerpt. ".repeat(20) + "Final conclusion.";
    const inputs: string[] = [];
    let fetched = 0;
    const { engine, store, article } = await setup("full-text", async (_agent, conversation, _question, _cwd, _signal, emit) => {
      inputs.push(conversation.source.text);
      emit({ type: "delta", text: "Summary" });
    }, false, async () => { fetched++; return { text: source, html: `<p>${source}</p>`, url: "https://example.com/full-article" }; });
    await engine.dispatch({ type: "chat.send", articleId: article.id, agent: "codex", text: "Summarize" });
    await engine.settle();
    await engine.dispatch({ type: "chat.send", articleId: article.id, agent: "codex", text: "Explain the final conclusion" });
    await engine.settle();
    expect(inputs).toEqual([source, source]);
    expect(fetched).toBe(1);
    expect(article.text).toBe("Evidence in the article.");
    expect(store.state.conversations[0]?.source).toMatchObject({ text: source, origin: "web", url: "https://example.com/full-article" });
    await engine.close();
  });

  test("article.fetchText stores the extracted page for reader view", async () => {
    const { engine, article, path } = await setup("reader-view", async () => {}, false, async () => ({ text: "Full extracted article text.", html: "<p>Full extracted article text.</p>", url: "https://example.com/full" }));
    await engine.dispatch({ type: "article.fetchText", id: article.id });
    expect(article.readerHtml).toBe("<p>Full extracted article text.</p>");
    expect(article.readerText).toBe("Full extracted article text.");
    expect((await Store.open(path)).state.articles[0]?.readerHtml).toBe("<p>Full extracted article text.</p>");
    await engine.close();
  });

  test("uses an explicitly marked feed fallback when the linked body cannot be retrieved", async () => {
    const sources: unknown[] = [];
    const { engine, store, article } = await setup("full-text-fallback", async (_agent, conversation, _question, _cwd, _signal, emit) => {
      sources.push(conversation.source);
      emit({ type: "delta", text: "Limited summary" });
    }, false, async () => { throw new Error("HTTP 403 private-debug-details"); });
    await engine.dispatch({ type: "chat.send", articleId: article.id, agent: "codex", text: "Summarize" });
    await engine.settle();
    expect(sources).toMatchObject([{ text: article.text, origin: "feed", fetchError: expect.any(String) }]);
    expect(store.state.conversations[0]?.source).not.toHaveProperty("fetchError", "HTTP 403 private-debug-details");
    await engine.close();
  });

  test("stopping during page retrieval never starts an agent", async () => {
    let started: (() => void) | undefined;
    const ready = new Promise<void>((resolve) => { started = resolve; });
    let runs = 0;
    const { engine, store, article } = await setup("stop-fetch", async () => { runs++; }, false, async (_url, signal) => {
      started?.();
      await new Promise<void>((resolve) => { signal.addEventListener("abort", () => resolve(), { once: true }); });
      return { text: "Late retrieved article", html: "<p>Late retrieved article</p>", url: "https://example.com/a" };
    });
    await engine.dispatch({ type: "chat.summarize", articleId: article.id, agent: "codex" });
    await ready;
    const conversation = store.state.conversations[0];
    if (!conversation) throw new Error("conversation missing");
    expect(conversation.messages.at(-1)).toMatchObject({ purpose: "summary", state: { status: "running", phase: "fetching" } });
    await engine.dispatch({ type: "chat.stop", conversationId: conversation.id });
    await engine.settle();
    expect(runs).toBe(0);
    expect(conversation.messages.at(-1)).toMatchObject({ state: { status: "cancelled" } });
    await engine.close();
  });

  test("upgrades legacy excerpt conversations while preserving their original source", async () => {
    let received = "";
    const { engine, store, article, path } = await setup("legacy-source", async (_agent, conversation) => { received = conversation.source.text; }, false, async () => ({ text: "Complete linked article with its conclusion.", html: "<p>Complete linked article with its conclusion.</p>", url: "https://example.com/a" }));
    store.state.conversations.push({ id: "legacy", articleId: article.id, agent: "codex", source: { title: article.title, url: article.url, text: article.text, capturedAt: article.receivedAt }, messages: [{ id: "old", role: "assistant", text: "Old excerpt answer", createdAt: article.receivedAt, state: { status: "completed" } }] });
    await engine.dispatch({ type: "chat.summarize", articleId: article.id, agent: "codex" });
    await engine.settle();
    const conversation = (await Store.open(path)).state.conversations[0];
    expect(received).toContain("conclusion");
    expect(conversation?.previousSource?.text).toBe(article.text);
    expect(conversation?.messages[0]?.text).toBe("Old excerpt answer");
    expect(conversation?.messages.at(-1)).toMatchObject({ purpose: "summary", sourceOrigin: "web" });
    await engine.close();
  });

  test("does not invoke an agent when neither the feed nor page contains text", async () => {
    let runs = 0;
    const { engine, store, article } = await setup("empty-source", async () => { runs++; }, false, async () => { throw new Error("blocked"); });
    article.text = "";
    await engine.dispatch({ type: "chat.summarize", articleId: article.id, agent: "codex" });
    await engine.settle();
    expect(runs).toBe(0);
    expect(store.state.conversations[0]?.messages.at(-1)).toMatchObject({ state: { status: "failed", error: "Could not fetch the article text. Open the original to read it." } });
    await engine.close();
  });

  test("stop preserves partial text and cannot be overwritten by a late successful runner", async () => {
    let started: (() => void) | undefined;
    const ready = new Promise<void>((resolve) => { started = resolve; });
    const { engine, store, article, path } = await setup("stop", async (_agent, _conversation, _question, _cwd, signal, emit) => {
      emit({ type: "delta", text: "Partial answer" });
      started?.();
      await new Promise<void>((resolve) => { if (signal.aborted) resolve(); else signal.addEventListener("abort", () => resolve(), { once: true }); });
      emit({ type: "delta", text: "Late answer that must be ignored" });
    });
    await engine.dispatch({ type: "chat.send", articleId: article.id, agent: "codex", text: "Summarize" });
    await ready;
    const conversation = store.state.conversations[0];
    if (!conversation) throw new Error("conversation missing");
    await expect(engine.dispatch({ type: "chat.send", articleId: article.id, agent: "codex", text: "Duplicate" })).rejects.toThrow("This conversation is running");
    await engine.dispatch({ type: "chat.stop", conversationId: conversation.id });
    await engine.settle();
    expect((await Store.open(path)).state.conversations[0]?.messages.at(-1)).toMatchObject({ text: "Partial answer", state: { status: "cancelled" } });
    await engine.close();
  });

  test("stopping mid-stream saves the partial answer with a partial flag", async () => {
    let started: (() => void) | undefined;
    const ready = new Promise<void>((resolve) => { started = resolve; });
    const { engine, store, article, path } = await setup("partial-stop", async (_agent, _conversation, _question, _cwd, signal, emit) => {
      emit({ type: "delta", text: "Half of the answer" });
      started?.();
      await new Promise<void>((resolve) => { if (signal.aborted) resolve(); else signal.addEventListener("abort", () => resolve(), { once: true }); });
    });
    await engine.dispatch({ type: "chat.send", articleId: article.id, agent: "codex", text: "Summarize" });
    await ready;
    const conversation = store.state.conversations[0];
    if (!conversation) throw new Error("conversation missing");
    await engine.dispatch({ type: "chat.stop", conversationId: conversation.id });
    await engine.settle();
    expect((await Store.open(path)).state.conversations[0]?.messages.at(-1)).toMatchObject({ text: "Half of the answer", partial: true, state: { status: "cancelled" } });
    await engine.close();
  });

  test("a mid-stream failure keeps the partial answer alongside the error", async () => {
    const { engine, store, article, path } = await setup("partial-fail", async (_agent, _conversation, _question, _cwd, _signal, emit) => {
      emit({ type: "delta", text: "Almost there" });
      throw new Error("boom");
    });
    await engine.dispatch({ type: "chat.send", articleId: article.id, agent: "codex", text: "Summarize" });
    await engine.settle();
    // toMatchObject mutates the received value on asymmetric matchers, so assert on a clone.
    expect(structuredClone(store.state.conversations[0]?.messages.at(-1))).toMatchObject({ text: "Almost there", partial: true, state: { status: "failed", error: expect.any(String) } });
    expect((await Store.open(path)).state.conversations[0]?.messages.at(-1)).toMatchObject({ text: "Almost there", partial: true });
    await engine.close();
  });

  test("a failure before any output keeps only the error", async () => {
    const { engine, store, article } = await setup("clean-fail", async () => { throw new Error("boom"); });
    await engine.dispatch({ type: "chat.send", articleId: article.id, agent: "codex", text: "Summarize" });
    await engine.settle();
    const message = store.state.conversations[0]?.messages.at(-1);
    expect(structuredClone(message)).toMatchObject({ text: "", state: { status: "failed", error: expect.any(String) } });
    expect(message).not.toHaveProperty("partial");
    await engine.close();
  });

  test("closing the engine mid-stream preserves the partial answer across restarts", async () => {
    let started: (() => void) | undefined;
    const ready = new Promise<void>((resolve) => { started = resolve; });
    const { engine, store, article, path } = await setup("partial-quit", async (_agent, _conversation, _question, _cwd, signal, emit) => {
      emit({ type: "delta", text: "Unfinished thought" });
      started?.();
      await new Promise<void>((resolve) => { if (signal.aborted) resolve(); else signal.addEventListener("abort", () => resolve(), { once: true }); });
      throw new Error("aborted");
    });
    await engine.dispatch({ type: "chat.send", articleId: article.id, agent: "codex", text: "Summarize" });
    await ready;
    expect(store.state.conversations[0]?.messages.at(-1)).toMatchObject({ text: "Unfinished thought", state: { status: "running" } });
    await engine.close();
    expect((await Store.open(path)).state.conversations[0]?.messages.at(-1)).toMatchObject({ text: "Unfinished thought", partial: true, state: { status: "cancelled" } });
  });

  test("a run interrupted by a hard exit is recovered as a partial answer", async () => {
    const path = join(directory, "partial-crash", "state.json");
    const store = await Store.open(path);
    const result = await parseFeed(xml, "https://example.com/rss", null);
    store.mergeFeed(result.feed, result.articles);
    store.state.conversations.push({ id: "crashed", articleId: result.articles[0]!.id, agent: "codex", source: { title: "T", url: "https://example.com/a", text: "body", capturedAt: new Date().toISOString() }, messages: [{ id: "m", role: "assistant", text: "Streamed so far", createdAt: new Date().toISOString(), state: { status: "running" } }] });
    await store.save();
    expect((await Store.open(path)).state.conversations[0]?.messages.at(-1)).toMatchObject({ text: "Streamed so far", partial: true, state: { status: "failed" } });
  });

  test("authentication is a waiting state, not a fake completed response", async () => {
    const { engine, store, article } = await setup("auth", async () => { throw new AuthenticationRequired("ログインしてください"); });
    await engine.dispatch({ type: "chat.send", articleId: article.id, agent: "claude", text: "Summarize" });
    await engine.settle();
    expect(store.state.conversations[0]?.messages.at(-1)).toMatchObject({ text: "", state: { status: "waiting", reason: "ログインしてください" } });
    await engine.close();
  });

  test("removing a feed survives restart, skips refresh, and restores its articles and conversations", async () => {
    const { engine, store, article, path } = await setup("remove-feed", async () => {});
    article.starred = true;
    await engine.dispatch({ type: "chat.send", articleId: article.id, agent: "codex", text: "Read" });
    await engine.settle();
    await engine.dispatch({ type: "feed.remove", id: article.feedId });
    const reopened = await Store.open(path);
    expect(reopened.state.feeds[0]?.removedAt).toEqual(expect.any(String));
    expect(reopened.article(article.id).starred).toBe(true);
    expect(reopened.state.conversations).toHaveLength(1);
    await engine.dispatch({ type: "refresh" });
    expect(store.state.feeds[0]?.removedAt).toEqual(expect.any(String));
    await engine.dispatch({ type: "feed.restore", id: article.feedId });
    expect((await Store.open(path)).state.feeds[0]?.removedAt).toBeUndefined();
    expect(store.article(article.id).starred).toBe(true);
    await engine.close();
  });

  test("an in-flight refresh cannot bring back a removed feed", async () => {
    let started: (() => void) | undefined;
    let release: (() => void) | undefined;
    const ready = new Promise<void>((resolve) => { started = resolve; });
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    const store = await Store.open(join(directory, "remove-during-refresh.json"));
    const parsed = await parseFeed(xml, "https://example.com/rss", null);
    store.mergeFeed(parsed.feed, parsed.articles);
    const engine = new Engine(store, directory, {
      run: async () => {}, connect: async (agent) => ({ agent, installed: false, status: "unavailable", detail: "fixture" }),
      fetchArticleText: async () => ({ text: "body", html: "<p>body</p>", url: "https://example.com/a" }),
      fetchFeed: async () => { started?.(); await waiting; return { ...parsed, feed: { ...parsed.feed, title: "Refreshed" } }; },
    });
    const refreshing = engine.dispatch({ type: "refresh" });
    await ready;
    await engine.dispatch({ type: "feed.remove", id: parsed.feed.id });
    release?.();
    await refreshing;
    expect(structuredClone(store.state.feeds[0])).toMatchObject({ title: "Test", removedAt: expect.any(String) });
    await engine.close();
  });

  test("imports valid OPML feeds, skips duplicates and reports individual failures", async () => {
    const { engine, store, article } = await setup("opml-import", async () => {});
    const xml = `<opml version="2.0"><head/><body><outline text="Imported"><outline text="New feed" xmlUrl="https://example.org/rss"/><outline text="Duplicate" xmlUrl="https://example.org/rss"/><outline text="Existing" xmlUrl="https://example.com/rss"/><outline text="Private" xmlUrl="http://127.0.0.1/rss"/></outline></body></opml>`;
    await engine.dispatch({ type: "opml.import", xml });
    await engine.settle();
    expect(engine.snapshot.opmlImport?.status).toBe("completed");
    expect(engine.snapshot.opmlImport?.results.map((result) => result.status).sort()).toEqual(["failed", "imported", "skipped", "skipped"]);
    const imported = store.state.feeds.find((feed) => feed.url === "https://example.org/rss");
    expect(imported?.folderId).toBe(store.state.folders.find((folder) => folder.name === "Imported")?.id);
    expect(store.state.feeds).toHaveLength(2);
    expect(store.article(article.id).read).toBe(false);
    await engine.close();
  });

  test("previews OPML entries with resolutions and missing feeds without mutating state", async () => {
    const { engine, store } = await setup("opml-preview", async () => {});
    const extra = await parseFeed(xml, "https://example.net/rss", null);
    store.mergeFeed(extra.feed, extra.articles);
    const removed = await parseFeed(xml, "https://example.org/rss", null);
    store.mergeFeed(removed.feed, removed.articles);
    const removedFeed = store.state.feeds.find((feed) => feed.id === removed.feed.id);
    if (!removedFeed) throw new Error("fixture missing");
    removedFeed.removedAt = new Date().toISOString();
    const opml = `<opml version="2.0"><body><outline text="F"><outline text="New" xmlUrl="https://example.dev/rss"/><outline text="Dup" xmlUrl="https://example.dev/rss"/><outline text="Existing" xmlUrl="https://example.com/rss"/><outline text="Removed" xmlUrl="https://example.org/rss"/><outline text="Private" xmlUrl="http://127.0.0.1/rss"/></outline></body></opml>`;
    const before = structuredClone(store.state);
    await engine.dispatch({ type: "opml.preview", xml: opml });
    expect(engine.snapshot.opmlPreview?.entries.map((entry) => entry.resolution)).toEqual(["new", "inFileDuplicate", "duplicate", "restorable", "invalid"]);
    expect(engine.snapshot.opmlPreview?.missingFeeds.map((feed) => feed.url)).toEqual(["https://example.net/rss"]);
    expect(store.state).toEqual(before);
    await engine.dispatch({ type: "opml.previewClear" });
    expect(engine.snapshot.opmlPreview).toBeNull();
    await engine.close();
  });

  test("imports only the URLs selected in the preview and clears it on completion", async () => {
    const { engine, store } = await setup("opml-subset", async () => {});
    const opml = `<opml version="2.0"><body><outline text="A" xmlUrl="https://a.example.com/rss"/><outline text="B" xmlUrl="https://b.example.com/rss"/></body></opml>`;
    await engine.dispatch({ type: "opml.preview", xml: opml });
    expect(engine.snapshot.opmlPreview?.missingFeeds.map((feed) => feed.url)).toEqual(["https://example.com/rss"]);
    await engine.dispatch({ type: "opml.import", xml: opml, urls: ["https://b.example.com/rss"] });
    await engine.settle();
    expect(engine.snapshot.opmlImport?.results.map((result) => result.status)).toEqual(["imported"]);
    expect(store.state.feeds.map((feed) => feed.url).sort()).toEqual(["https://b.example.com/rss", "https://example.com/rss"]);
    expect(engine.snapshot.opmlPreview).toBeNull();
    await engine.close();
  });

  test("stopping an OPML import aborts retrieval and does not add late results", async () => {
    let started: (() => void) | undefined;
    const ready = new Promise<void>((resolve) => { started = resolve; });
    const store = await Store.open(join(directory, "stop-opml.json"));
    const engine = new Engine(store, directory, {
      run: async () => {}, connect: async (agent) => ({ agent, installed: false, status: "unavailable", detail: "fixture" }),
      fetchArticleText: async () => ({ text: "body", html: "<p>body</p>", url: "https://example.com/a" }),
      fetchFeed: async (url, folderId, signal) => {
        started?.();
        await new Promise<void>((resolve) => { signal?.addEventListener("abort", () => resolve(), { once: true }); });
        return parseFeed(xml, url, folderId);
      },
    });
    await engine.dispatch({ type: "opml.import", xml: '<opml version="2.0"><head/><body><outline text="Late" xmlUrl="https://example.com/rss"/></body></opml>' });
    await ready;
    await expect(engine.dispatch({ type: "opml.import", xml: '<opml version="2.0"><head/><body/></opml>' })).rejects.toThrow("An OPML import is running");
    await engine.dispatch({ type: "opml.stop" });
    await engine.settle();
    expect(engine.snapshot.opmlImport?.status).toBe("cancelled");
    expect(store.state.feeds).toHaveLength(0);
    await engine.close();
  });

  test("proposes and applies a library organize plan, dropping invalid moves", async () => {
    const { engine, store, path } = await setup("organize", async () => {}, false, undefined, async (_agent, prompt, _cwd, _signal, emit) => {
      const feeds = JSON.parse(prompt).feeds as { id: string }[];
      emit({ type: "delta", text: `説明\n{"moves":[{"feedId":"${feeds[0]?.id ?? ""}","folder":"Tech"},{"feedId":"missing","folder":"X"},{"feedId":"${feeds[0]?.id ?? ""}","folder":""}]}` });
    });
    const feed = store.state.feeds[0];
    if (!feed) throw new Error("fixture missing");
    await engine.dispatch({ type: "organize.propose", agent: "codex", scope: "library" });
    await engine.settle();
    const job = engine.snapshot.organize;
    expect(job).toMatchObject({ scope: "library", status: "completed" });
    expect(job?.plan?.moves).toEqual([{ feedId: feed.id, title: "Test", folderName: "Tech", newFolder: true }]);
    await engine.dispatch({ type: "organize.apply", moves: job?.plan?.moves ?? [] });
    const folder = store.state.folders.find((item) => item.name === "Tech");
    expect(store.state.feeds[0]?.folderId).toBe(folder?.id);
    expect((await Store.open(path)).state.feeds[0]?.folderId).toBe(folder?.id);
    expect(engine.snapshot.organize).toBeNull();
    await engine.close();
  });

  test("fails the organize job when the response is not parseable", async () => {
    const { engine } = await setup("organize-bad", async () => {}, false, undefined, async (_agent, _prompt, _cwd, _signal, emit) => {
      emit({ type: "delta", text: "整理案はありません" });
    });
    await engine.dispatch({ type: "organize.propose", agent: "codex", scope: "library" });
    await engine.settle();
    expect(engine.snapshot.organize).toMatchObject({ status: "failed", detail: "Could not interpret the plan. Please try again." });
    await engine.dispatch({ type: "organize.clear" });
    expect(engine.snapshot.organize).toBeNull();
    await engine.close();
  });

  test("applies opml folder assignments to preview entries only", async () => {
    const { engine, store } = await setup("organize-opml", async () => {}, false, undefined, async (_agent, _prompt, _cwd, _signal, emit) => {
      emit({ type: "delta", text: `{"assignments":[{"url":"https://a.example.com/rss","folder":"News"},{"url":"https://unknown.example.com/rss","folder":"X"}]}` });
    });
    const opml = `<opml version="2.0"><body><outline text="A" xmlUrl="https://a.example.com/rss"/><outline text="B" xmlUrl="https://b.example.com/rss"/></body></opml>`;
    await expect(engine.dispatch({ type: "organize.propose", agent: "codex", scope: "opml" })).rejects.toThrow("preview");
    await engine.dispatch({ type: "opml.preview", xml: opml });
    await engine.dispatch({ type: "organize.propose", agent: "codex", scope: "opml" });
    await engine.settle();
    expect(engine.snapshot.organize?.plan?.assignments).toEqual([{ url: "https://a.example.com/rss", title: "A", folderName: "News" }]);
    await engine.dispatch({ type: "organize.apply", assignments: engine.snapshot.organize?.plan?.assignments ?? [] });
    const entry = engine.snapshot.opmlPreview?.entries.find((item) => item.url === "https://a.example.com/rss");
    expect(entry?.folderName).toBe("News");
    expect(entry?.detail).toBe("Folder “News” will be created.");
    expect(engine.snapshot.organize).toBeNull();
    const folders = Object.fromEntries((engine.snapshot.opmlPreview?.entries ?? []).flatMap((item) => item.folderName ? [[item.url, item.folderName]] : []));
    await engine.dispatch({ type: "opml.import", xml: opml, urls: ["https://a.example.com/rss"], folders });
    await engine.settle();
    expect(engine.snapshot.opmlImport?.results[0]?.status).toBe("imported");
    const imported = store.state.feeds.find((item) => item.url === "https://a.example.com/rss");
    expect(imported?.folderId).toBe(store.state.folders.find((item) => item.name === "News")?.id);
    await engine.close();
  });

  test("cancelling an organize job clears it", async () => {
    let started: (() => void) | undefined;
    const ready = new Promise<void>((resolve) => { started = resolve; });
    const { engine } = await setup("organize-cancel", async () => {}, false, undefined, async (_agent, _prompt, _cwd, signal) => {
      started?.();
      await new Promise<void>((resolve) => { signal.addEventListener("abort", () => resolve(), { once: true }) });
    });
    await engine.dispatch({ type: "organize.propose", agent: "codex", scope: "library" });
    await ready;
    await engine.dispatch({ type: "organize.cancel" });
    await engine.settle();
    expect(engine.snapshot.organize).toBeNull();
    await engine.close();
  });

  test("removing a folder unassigns its feeds and persists", async () => {
    const { engine, store, path } = await setup("folder-remove", async () => {});
    await engine.dispatch({ type: "folder.save", id: null, name: "News" });
    const folder = store.state.folders.find((item) => item.name === "News");
    await engine.dispatch({ type: "feed.move", id: store.state.feeds[0]?.id ?? "", folderId: folder?.id ?? null });
    await engine.dispatch({ type: "folder.remove", id: folder?.id ?? "" });
    expect(store.state.folders).toHaveLength(0);
    expect(store.state.feeds[0]?.folderId).toBeNull();
    expect((await Store.open(path)).state.feeds[0]?.folderId).toBeNull();
    await expect(engine.dispatch({ type: "folder.remove", id: folder?.id ?? "" })).rejects.toThrow("Folder not found.");
    await engine.close();
  });

  test("refresh failure preserves cached articles and reports the feed error", async () => {
    const { engine, store } = await setup("refresh", async () => {}, true);
    await engine.dispatch({ type: "refresh" });
    expect(store.state.articles).toHaveLength(1);
    expect(store.state.feeds[0]?.error).toBe("Network failed");
    expect(engine.refreshing).toBe(false);
    await engine.close();
  });

  test("automatic refresh reuses validators, clears failures on 304, and backs off errors", async () => {
    const calls: ({ etag?: string; lastModified?: string } | undefined)[] = [];
    let mode: "ok" | "fail" | "stale" = "ok";
    const path = join(directory, "auto-refresh", "state.json");
    const store = await Store.open(path);
    const parsed = await parseFeed(xml, "https://example.com/rss", null);
    parsed.feed.etag = "v1";
    store.mergeFeed(parsed.feed, parsed.articles);
    const connect: typeof connection = async (agent) => ({ agent, installed: true, status: "ready", detail: "fixture" });
    const engine = new Engine(store, join(directory, "auto-refresh", "runner"), {
      connect,
      fetchFeed: async (url, folderId, _signal, _lang, cache) => {
        calls.push(cache);
        if (mode === "fail") throw new Error("Network failed");
        const again = await parseFeed(xml, url, folderId);
        return mode === "stale" ? { feed: again.feed, articles: again.articles, notModified: true } : { ...again, etag: "v2" };
      },
    });
    await engine.initialize();
    await engine.dispatch({ type: "refresh" });
    expect(calls.at(-1)).toEqual({ etag: "v1" });
    expect(store.state.feeds[0]?.etag).toBe("v2");
    store.state.feeds[0]!.error = "earlier failure";
    mode = "stale";
    await engine.dispatch({ type: "refresh", automatic: true });
    expect(store.state.feeds[0]?.error).toBeNull();
    expect(store.state.feeds[0]?.etag).toBe("v2");
    mode = "fail";
    await engine.dispatch({ type: "refresh" });
    const failed = store.state.feeds[0];
    expect(failed?.failures).toBe(1);
    expect(failed?.backoffUntil).toBeString();
    const fetched = calls.length;
    await engine.dispatch({ type: "refresh", automatic: true });
    expect(calls).toHaveLength(fetched);
    await engine.dispatch({ type: "refresh" });
    expect(calls).toHaveLength(fetched + 1);
    await engine.dispatch({ type: "app.setRefreshInterval", minutes: 45 });
    expect((await Store.open(path)).state.refreshMinutes).toBe(45);
    await engine.close();
  });

  test("bulk mark-read with undo restores only the flipped articles", async () => {
    const { engine, store, article } = await setup("mark-read", async () => {});
    store.saveFolder(null, "Folder");
    const folder = store.state.folders[0]!;
    store.state.feeds[0]!.folderId = folder.id;
    article.read = true;
    const unread = await parseFeed(xml.replaceAll("article", "second"), "https://example.com/rss", null);
    store.state.articles.push(...unread.articles);
    expect(store.state.articles.filter((item) => !item.read)).toHaveLength(1);
    await engine.dispatch({ type: "articles.markRead", scope: { type: "folder", id: folder.id } });
    expect(store.state.articles.every((item) => item.read)).toBe(true);
    expect(engine.snapshot.markReadUndo).toEqual({ count: 1 });
    await engine.dispatch({ type: "articles.markReadUndo" });
    expect(store.state.articles.filter((item) => !item.read)).toHaveLength(1);
    expect(store.state.articles[0]?.read).toBe(true);
    expect(engine.snapshot.markReadUndo).toBeNull();
    await engine.close();
  });
  test("bulk mark-read skips removed feeds and undo skips articles touched afterwards", async () => {
    const { engine, store, article } = await setup("mark-read-undo", async () => {});
    const folder = store.state.folders[0] ?? (store.saveFolder(null, "Folder"), store.state.folders[0]!);
    store.state.feeds[0]!.folderId = folder.id;
    const removed = await parseFeed(xml.replaceAll("article", "removed"), "https://example.com/rss2", null);
    removed.feed.folderId = folder.id;
    removed.feed.removedAt = new Date().toISOString();
    store.state.feeds.push(removed.feed);
    store.state.articles.push(...removed.articles);
    article.read = true;
    await engine.dispatch({ type: "articles.markRead", scope: { type: "folder", id: folder.id } });
    expect(store.state.articles.filter((item) => item.feedId === removed.feed.id).every((item) => !item.read)).toBe(true);
    expect(engine.snapshot.markReadUndo).toBeNull();
    const fresh = await parseFeed(xml.replaceAll("article", "third"), "https://example.com/rss", null);
    store.state.articles.push(...fresh.articles);
    await engine.dispatch({ type: "articles.markRead", scope: { type: "feed", id: store.state.feeds[0]!.id } });
    expect(engine.snapshot.markReadUndo?.count).toBeGreaterThan(0);
    const touched = store.state.articles.at(-1)!;
    await engine.dispatch({ type: "article.read", id: touched.id, read: false });
    await engine.dispatch({ type: "article.read", id: touched.id, read: true });
    await engine.dispatch({ type: "articles.markReadUndo" });
    expect(touched.read).toBe(true);
    await engine.close();
  });
  test("digest refuses articles without body text and streams into the snapshot", async () => {
    let question = "";
    const { engine, store, article } = await setup("digest", async (_agent, _conversation, q, _cwd, _signal, emit) => { question = q; emit({ type: "delta", text: "Digest" }); });
    const empty = await parseFeed(xml, "https://example.com/rss2", null);
    empty.articles.forEach((item) => { item.text = ""; });
    store.state.articles.push(...empty.articles);
    await engine.dispatch({ type: "digest.run", articleIds: [empty.articles[0]!.id, empty.articles[1]?.id ?? empty.articles[0]!.id], agent: "codex" });
    expect(engine.snapshot.digest?.status).toBe("failed");
    await engine.dispatch({ type: "digest.clear" });
    const second = await parseFeed(xml.replaceAll("article", "peer"), "https://example.com/rss", null);
    store.state.articles.push(...second.articles);
    await engine.dispatch({ type: "digest.run", articleIds: [article.id, second.articles[0]!.id], agent: "codex" });
    await engine.settle();
    expect(engine.snapshot.digest).toMatchObject({ status: "completed", text: "Digest" });
    expect(question.length).toBeGreaterThan(0);
    await engine.close();
  });
  test("digest condenses an oversized article to its per-article budget instead of slicing mid-sentence", async () => {
    const condensed: { text: string; budget: number }[] = [];
    let source = "";
    const { engine, store, article } = await setup("digest-condense",
      async (_agent, conversation, _question, _cwd, _signal, emit) => { source = conversation.source.text; emit({ type: "delta", text: "Digest" }); },
      false, undefined, undefined,
      async (_agent, text, budget) => { condensed.push({ text, budget }); return "condensed-body"; });
    article.text = "a".repeat(40_000);
    const second = await parseFeed(xml.replaceAll("article", "peer2"), "https://example.com/rss", null);
    store.state.articles.push(...second.articles);
    await engine.dispatch({ type: "digest.run", articleIds: [article.id, second.articles[0]!.id], agent: "codex" });
    await engine.settle();
    expect(engine.snapshot.digest).toMatchObject({ status: "completed", text: "Digest" });
    expect(condensed).toEqual([{ text: "a".repeat(40_000), budget: 15_000 }]);
    expect(source).toContain("condensed-body");
    expect(source).not.toContain("a".repeat(1_000));
    await engine.close();
  });

  test("library export and import round-trip the full library", async () => {
    const { engine, store, article } = await setup("library-export", async (_agent, _conversation, _question, _cwd, _signal, emit) => { emit({ type: "delta", text: "Hi" }); });
    article.starred = true;
    article.note = "Keep this";
    article.readerText = "Reader text";
    article.highlights = ["Marked passage"];
    store.saveFolder(null, "Tech");
    store.state.feeds[0]!.folderId = store.state.folders[0]!.id;
    await engine.dispatch({ type: "chat.send", articleId: article.id, agent: "codex", text: "Hi" });
    await engine.settle();
    await engine.dispatch({ type: "app.setLanguage", language: "ja" });
    await engine.dispatch({ type: "app.setRefreshInterval", minutes: 60 });
    await engine.dispatch({ type: "app.setFontSize", size: "l" });
    await engine.dispatch({ type: "app.setArticlesRetention", days: 90 });
    const exported = await engine.dispatch({ type: "library.export" }) as LibraryExport;
    expect(exported.version).toBe(1);
    expect(Date.parse(exported.exportedAt)).not.toBeNaN();
    const backup = exported;
    expect(backup.articles[0]).toMatchObject({ id: article.id, starred: true, note: "Keep this", readerText: "Reader text", highlights: ["Marked passage"] });
    expect(backup.settings).toMatchObject({ language: "ja", refreshInterval: 60, fontSize: "l", articlesRetentionDays: 90 });
    expect(backup).not.toHaveProperty("conversations");

    const path2 = join(directory, "library-import", "state.json");
    const store2 = await Store.open(path2);
    store2.state.conversations.push(
      { id: "kept", articleId: article.id, agent: "codex", source: { title: "T", url: "https://example.com/a", text: "", capturedAt: new Date().toISOString() }, messages: [] },
      { id: "dropped", articleId: "missing", agent: "codex", source: { title: "T", url: "https://example.com/a", text: "", capturedAt: new Date().toISOString() }, messages: [] },
    );
    const connect: typeof connection = async (agent) => ({ agent, installed: true, status: "ready", detail: "fixture" });
    const engine2 = new Engine(store2, join(directory, "library-import", "runner"), { run: async () => {}, connect, fetchFeed: async () => { throw new Error("unused"); } });
    await engine2.initialize();
    await engine2.dispatch({ type: "library.import", json: JSON.stringify(exported) });
    expect(store2.state).toMatchObject({ language: "ja", refreshMinutes: 60, fontSize: "l", articlesRetentionDays: 90 });
    expect(store2.state.articles[0]).toMatchObject({ id: article.id, starred: true, note: "Keep this" });
    expect(store2.state.feeds[0]?.folderId).toBe(store2.state.folders[0]?.id);
    expect(store2.state.conversations.map((item) => item.id)).toEqual(["kept"]);
    expect((await Store.open(path2)).state.articles).toHaveLength(1);
    const reExported = await engine2.dispatch({ type: "library.export" }) as LibraryExport;
    const strip = (doc: LibraryExport) => ({ ...doc, exportedAt: "" });
    expect(strip(reExported)).toEqual(strip(backup));
    await engine.close();
    await engine2.close();
  });

  test("library import rejects malformed files and an empty backup wipes the library", async () => {
    const { engine, store } = await setup("library-bad", async () => {});
    const before = structuredClone(store.state);
    await expect(engine.dispatch({ type: "library.import", json: "not json" })).rejects.toThrow("not a valid Reedar library backup");
    await expect(engine.dispatch({ type: "library.import", json: JSON.stringify({ version: 2, exportedAt: "", feeds: [], folders: [], articles: [], settings: {} }) })).rejects.toThrow("not a valid Reedar library backup");
    await expect(engine.dispatch({ type: "library.import", json: JSON.stringify({ version: 1, exportedAt: "", feeds: [], folders: [], articles: [], settings: { language: "tr" } }) })).rejects.toThrow("not a valid Reedar library backup");
    expect(store.state).toEqual(before);
    await engine.dispatch({ type: "library.import", json: JSON.stringify({ version: 1, exportedAt: "", feeds: [], folders: [], articles: [], settings: {} }) });
    expect(store.state.feeds).toHaveLength(0);
    expect(store.state.articles).toHaveLength(0);
    const hostile = JSON.parse(JSON.stringify(before.articles[0])) as Article;
    hostile.html = "<p>Body</p><script>alert(1)</script><iframe src=\"https://evil.example\"></iframe>";
    hostile.readerHtml = "<p>Reader</p><script>alert(1)</script>";
    await engine.dispatch({ type: "library.import", json: JSON.stringify({ version: 1, exportedAt: "", feeds: before.feeds, folders: [], articles: [hostile], settings: {} }) });
    expect(store.state.articles[0]?.html).toBe("<p>Body</p>");
    expect(store.state.articles[0]?.readerHtml).toBe("<p>Reader</p>");
    await engine.close();
  });

  test("restoring while a refresh is in flight does not lose the backup to late merges", async () => {
    let release: (() => void) | undefined;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    const path = join(directory, "library-race", "state.json");
    const store = await Store.open(path);
    const parsed = await parseFeed(xml, "https://example.com/rss", null);
    store.mergeFeed(parsed.feed, parsed.articles);
    const connect: typeof connection = async (agent) => ({ agent, installed: true, status: "ready", detail: "fixture" });
    const engine = new Engine(store, join(directory, "library-race", "runner"), {
      run: async () => {}, connect,
      fetchFeed: async (url, folderId) => { await waiting; return parseFeed(xml.replaceAll("article", "fresh"), url, folderId); },
    });
    await engine.initialize();
    const refreshing = engine.dispatch({ type: "refresh" });
    const backup = structuredClone(await engine.dispatch({ type: "library.export" })) as { articles: { id: string; title: string }[] };
    backup.articles[0]!.title = "Restored title";
    const importing = engine.dispatch({ type: "library.import", json: JSON.stringify(backup) });
    await new Promise((resolve) => setTimeout(resolve, 10));
    release?.();
    await Promise.all([refreshing, importing]);
    expect(store.state.articles.map((item) => item.title)).toEqual(["Restored title"]);
    expect(store.state.articles.map((item) => item.id)).toEqual([parsed.articles[0]!.id]);
    expect(store.state.articles[0]?.read).toBe(false);
    await engine.close();
  });

  test("chat.delete removes the conversation but keeps its article", async () => {
    const { engine, store, article, path } = await setup("chat-delete", async (_agent, _conversation, _question, _cwd, _signal, emit) => { emit({ type: "delta", text: "Done" }); });
    await engine.dispatch({ type: "chat.send", articleId: article.id, agent: "codex", text: "Hi" });
    await engine.settle();
    const conversation = store.state.conversations[0];
    if (!conversation) throw new Error("fixture missing");
    expect(conversation.messages).toHaveLength(2);
    await engine.dispatch({ type: "chat.delete", conversationId: conversation.id });
    expect(store.state.conversations).toHaveLength(0);
    expect(store.article(article.id).id).toBe(article.id);
    expect((await Store.open(path)).state.conversations).toHaveLength(0);
    await expect(engine.dispatch({ type: "chat.delete", conversationId: conversation.id })).rejects.toThrow("Conversation not found");
    await engine.dispatch({ type: "chat.send", articleId: article.id, agent: "codex", text: "Again" });
    await engine.settle();
    expect(store.state.conversations).toHaveLength(1);
    await engine.close();
  });

  test("retention drops only old unread, unstarred, unannotated articles", async () => {
    const { engine, store, article, path } = await setup("retention", async () => {});
    const old = new Date(Date.now() - 45 * 86_400_000).toISOString();
    const add = async (guid: string, mark?: (item: Article) => void) => {
      const parsed = await parseFeed(xml.replaceAll("article", guid), "https://example.com/rss", null);
      parsed.articles[0]!.publishedAt = old;
      mark?.(parsed.articles[0]!);
      store.state.articles.push(...parsed.articles);
      return parsed.articles[0]!;
    };
    await engine.dispatch({ type: "chat.send", articleId: article.id, agent: "codex", text: "Hi" });
    await engine.settle();
    const recent = await add("recent");
    recent.publishedAt = new Date().toISOString();
    const starred = await add("starred", (item) => { item.starred = true; });
    const noted = await add("noted", (item) => { item.note = "pin"; });
    const highlighted = await add("highlight", (item) => { item.highlights = ["mark"]; });
    const read = await add("read", (item) => { item.read = true; });
    article.publishedAt = old;
    const keptIds = new Set([recent.id, starred.id, noted.id, highlighted.id, read.id]);
    await engine.dispatch({ type: "app.setArticlesRetention", days: 30 });
    expect(new Set(store.state.articles.map((item) => item.id))).toEqual(keptIds);
    expect(store.state.conversations).toHaveLength(0);
    expect((await Store.open(path)).state.articles).toHaveLength(keptIds.size);
    await engine.close();

    const path3 = join(directory, "retention-start", "state.json");
    const store3 = await Store.open(path3);
    const parsed3 = await parseFeed(xml, "https://example.com/rss", null);
    parsed3.articles[0]!.publishedAt = old;
    store3.mergeFeed(parsed3.feed, parsed3.articles);
    store3.state.articlesRetentionDays = 30;
    const connect: typeof connection = async (agent) => ({ agent, installed: true, status: "ready", detail: "fixture" });
    const engine3 = new Engine(store3, join(directory, "retention-start", "runner"), { run: async () => {}, connect, fetchFeed: async () => { throw new Error("unused"); } });
    await engine3.initialize();
    expect(store3.state.articles).toHaveLength(0);
    await engine3.close();
  });

  test("library import re-sanitizes article HTML instead of trusting the backup", async () => {
    const { engine, store } = await setup("library-sanitize", async () => {});
    const exported = await engine.dispatch({ type: "library.export" }) as LibraryExport;
    exported.articles[0]!.readerHtml = '<p>ok</p><script>alert(1)</script><img src="https://e.com/i.png" onerror="alert(2)"><img src="/image?url=https%3A%2F%2Fe.com%2Fkept.png">';
    await engine.dispatch({ type: "library.import", json: JSON.stringify(exported) });
    const html = store.state.articles[0]!.readerHtml!;
    expect(html).not.toMatch(/script|onerror/);
    expect(html).toContain("/image?url=");
    expect(html).toContain("/image?url=https%3A%2F%2Fe.com%2Fkept.png");
    expect(html).not.toContain("image%3Furl%3D");
    await engine.close();
  });

  test("digest runs the apple agent on the pcc tier and records the emitted notice", async () => {
    const models: (string | undefined)[] = [];
    const { engine, store, article } = await setup("digest-pcc", async (_agent, _conversation, _q, _cwd, _signal, emit, _lang, model) => {
      models.push(model);
      emit({ type: "notice", text: "cloud" });
      emit({ type: "delta", text: "Digest" });
    });
    const second = await parseFeed(xml.replaceAll("article", "peer"), "https://example.com/rss", null);
    store.state.articles.push(...second.articles);
    await engine.dispatch({ type: "digest.run", articleIds: [article.id, second.articles[0]!.id], agent: "apple" });
    await engine.settle();
    expect(models).toEqual(["pcc"]);
    expect(engine.snapshot.digest).toMatchObject({ status: "completed", notice: "cloud" });
    await engine.close();
  });
  test("digest retains condensation notices after the final answer and deduplicates chunk notices", async () => {
    const { engine, store, article } = await setup("digest-condense-notice", async (_agent, _conversation, _q, _cwd, _signal, emit) => {
      emit({ type: "notice", text: "Cloud answer" });
      emit({ type: "delta", text: "Digest" });
    }, false, undefined, undefined, async (_agent, _text, _budget, _signal, _cwd, _lang, _model, emit) => {
      emit?.({ type: "notice", text: "Condensed on-device" });
      emit?.({ type: "notice", text: "Condensed on-device" });
      return "Condensed body";
    });
    article.text = "a".repeat(20_000);
    const second = { ...article, id: "digest-peer", title: "Peer" };
    store.state.articles.push(second);
    await engine.dispatch({ type: "digest.run", articleIds: [article.id, second.id], agent: "apple" });
    await engine.settle();
    expect(engine.snapshot.digest).toMatchObject({ status: "completed", text: "Digest", notice: "Condensed on-device\nCloud answer" });
    await engine.close();
  });
  test("digest keeps every selected article in the prompt when text is newline-heavy", async () => {
    let source = "";
    const models: string[] = [];
    const { engine, store, article } = await setup("digest-escape", async (_agent, conversation) => { source = conversation.source.text; }, false, undefined, undefined, async (_agent, text, budget, _signal, _cwd, _lang, model) => {
      models.push(model ?? "system");
      return text.slice(0, budget);
    });
    const articles = Array.from({ length: 20 }, (_, i) => ({ ...article, id: `a${i}`, title: `A${i}`, text: "line\n".repeat(3000) }));
    store.state.articles.push(...articles);
    await engine.dispatch({ type: "digest.run", articleIds: articles.map((item) => item.id), agent: "apple" });
    await engine.settle();
    expect(engine.snapshot.digest?.status).toBe("completed");
    expect(models).toEqual(Array(20).fill("pcc"));
    for (let i = 0; i < 20; i++) expect(source).toContain(`## A${i}\n`);
    await engine.close();
  });
  test("digest keeps a body floor and stays under budget when titles alone exceed it", async () => {
    let source = "";
    const { engine, store, article } = await setup("digest-floor", async (_agent, conversation) => { source = conversation.source.text; });
    const articles = Array.from({ length: 20 }, (_, i) => ({ ...article, id: `g${i}`, title: `T${i}` + "T".repeat(4600), text: `body${i} `.repeat(400) }));
    store.state.articles.push(...articles);
    await engine.dispatch({ type: "digest.run", articleIds: articles.map((item) => item.id), agent: "apple" });
    await engine.settle();
    expect(source.length).toBeLessThan(92_000);
    expect(source).toContain(`body${19} `);
    await engine.close();
  });
  test("digest shrinks an escape-heavy title instead of dropping the body", async () => {
    let source = "";
    const { engine, store, article } = await setup("digest-quotes", async (_agent, conversation) => { source = conversation.source.text; });
    const quoted = { ...article, id: "quoted", title: "\"".repeat(14_000), text: "key finding" };
    const short = { ...article, id: "short", title: "Short", text: "ok" };
    store.state.articles.push(quoted, short);
    await engine.dispatch({ type: "digest.run", articleIds: ["quoted", "short"], agent: "codex" });
    await engine.settle();
    expect(source).toContain("key finding");
    expect(source).toContain(quoted.url);
    await engine.close();
  });
  test("the apple model setting persists and an agent notice lands on the assistant message", async () => {
    const { engine, store, article, path } = await setup("apple-model", async (_agent, _conversation, _q, _cwd, _signal, emit) => {
      emit({ type: "notice", text: "cloud answer" });
      emit({ type: "delta", text: "Answer" });
    });
    await engine.dispatch({ type: "app.setAppleModel", model: "pcc" });
    expect(store.state.appleModel).toBe("pcc");
    expect((await Store.open(path)).state.appleModel).toBe("pcc");
    await engine.dispatch({ type: "chat.send", articleId: article.id, agent: "apple", text: "Summarize" });
    await engine.settle();
    expect(store.state.conversations[0]?.messages.at(-1)).toMatchObject({ notice: "cloud answer", text: "Answer", state: { status: "completed" } });
    await engine.close();
  });
  test("reader retains condensation notices alongside the final model notice on restart", async () => {
    const { engine, article, path } = await setup("reader-condense-notice", async (_agent, _conversation, _q, _cwd, _signal, emit) => {
      emit({ type: "notice", text: "Cloud answer" });
      emit({ type: "notice", text: "Condensed on-device" });
      emit({ type: "notice", text: "Condensed on-device" });
      emit({ type: "delta", text: "Answer" });
    });
    await engine.dispatch({ type: "chat.send", articleId: article.id, agent: "apple", text: "Summarize" });
    await engine.settle();
    await engine.close();
    const reopened = await Store.open(path);
    expect(reopened.state.conversations[0]?.messages.at(-1)).toMatchObject({
      notice: "Cloud answer\nCondensed on-device", text: "Answer", state: { status: "completed" },
    });
    reopened.close();
  });
});
