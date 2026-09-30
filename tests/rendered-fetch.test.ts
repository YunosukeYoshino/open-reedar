import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { loadArticleText } from "../src/main/article-text";
import { Engine } from "../src/main/engine";
import { parseFeed } from "../src/main/feeds";
import { Store } from "../src/main/store";

const directory = await mkdtemp(join(tmpdir(), "reedar-render-test-"));
afterAll(async () => { await Bun.spawn(["trash", directory]).exited; });
const xml = `<rss version="2.0"><channel><title>Test</title><link>https://example.com</link><item><guid>article</guid><title>Article</title><link>https://example.com/a</link><description>Evidence in the article.</description></item></channel></rss>`;

const thin = { text: "Thin static extract.", html: "<p>Thin static extract.</p>", url: "https://example.com/a" };
const rich = { text: `Rendered article body. ${"Full client-side content. ".repeat(40)}`, html: "<p>Rendered article body.</p>", url: "https://example.com/a" };

async function setup(name: string, fetchArticleText: typeof loadArticleText, renderArticleText?: typeof loadArticleText) {
  const store = await Store.open(join(directory, name, "state.json"));
  const result = await parseFeed(xml, "https://example.com/rss", null);
  store.mergeFeed(result.feed, result.articles);
  const engine = new Engine(store, join(directory, name, "runner"), {
    fetchArticleText, renderArticleText,
    connect: async (agent) => ({ agent, installed: true, status: "ready", detail: "fixture" }),
  });
  await engine.initialize();
  const article = store.state.articles[0];
  if (!article) throw new Error("fixture missing");
  return { engine, store, article };
}

describe("rendered fetch fallback", () => {
  test("thin static result retries through the rendered fetch", async () => {
    let rendered = 0;
    const { engine, store, article } = await setup("thin", async () => thin, async () => { rendered++; return rich; });
    await engine.dispatch({ type: "article.fetchText", id: article.id });
    const updated = store.state.articles[0];
    expect(rendered).toBe(1);
    expect(updated?.readerText).toBe(rich.text);
    expect(updated?.readerHtml).toBe(rich.html);
  });

  test("rich static result skips the rendered fetch", async () => {
    let rendered = 0;
    const { engine, store, article } = await setup("rich", async () => rich, async () => { rendered++; return thin; });
    await engine.dispatch({ type: "article.fetchText", id: article.id });
    const updated = store.state.articles[0];
    expect(rendered).toBe(0);
    expect(updated?.readerText).toBe(rich.text);
  });

  test("static extraction failure retries through the rendered fetch", async () => {
    let rendered = 0;
    const { engine, store, article } = await setup("static-fail", async () => { throw new Error("Could not extract the article text from the link."); }, async () => { rendered++; return rich; });
    await engine.dispatch({ type: "article.fetchText", id: article.id });
    const updated = store.state.articles[0];
    expect(rendered).toBe(1);
    expect(updated?.readerText).toBe(rich.text);
  });

  test("render failure keeps the thin static result", async () => {
    const { engine, store, article } = await setup("render-fail", async () => thin, async () => { throw new Error("render timed out"); });
    await engine.dispatch({ type: "article.fetchText", id: article.id });
    const updated = store.state.articles[0];
    expect(updated?.readerText).toBe(thin.text);
    expect(updated?.readerHtml).toBe(thin.html);
  });

  test("both fetches failing propagates the static error", async () => {
    const { engine, store, article } = await setup("both-fail", async () => { throw new Error("Could not extract the article text from the link."); }, async () => { throw new Error("render timed out"); });
    await expect(engine.dispatch({ type: "article.fetchText", id: article.id })).rejects.toThrow("Could not extract the article text from the link.");
    expect(store.state.articles[0]?.readerText).toBeUndefined();
  });

  test("thinner rendered result keeps the static result", async () => {
    const { engine, store, article } = await setup("render-thinner", async () => thin, async () => ({ ...rich, text: "short" }));
    await engine.dispatch({ type: "article.fetchText", id: article.id });
    expect(store.state.articles[0]?.readerText).toBe(thin.text);
  });
});
