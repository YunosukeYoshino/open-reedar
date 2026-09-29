import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cli } from "../src/cli/reedar";
import { installCli } from "../src/main/cli-install";
import { parseFeed } from "../src/main/feeds";
import { Store } from "../src/main/store";

const directory = await mkdtemp(join(tmpdir(), "reedar-cli-test-"));
afterAll(async () => { await Bun.spawn(["trash", directory]).exited; });
const xml = `<rss version="2.0"><channel><title>Test Feed</title><link>https://example.com</link><item><guid>one</guid><title>Unread Story</title><link>https://example.com/one</link><description>First body.</description></item><item><guid>two</guid><title>Read Story</title><link>https://example.com/two</link><description>Second body.</description></item></channel></rss>`;

async function seed(name: string) {
  const path = join(directory, name, "reader.json");
  const store = await Store.open(path);
  store.saveFolder(null, "Tech");
  const result = await parseFeed(xml, "https://example.com/rss", store.state.folders[0]?.id ?? null);
  store.mergeFeed(result.feed, result.articles);
  const readArticle = store.state.articles.find((article) => article.title === "Read Story");
  if (readArticle) { readArticle.read = true; readArticle.starred = true; }
  await store.save();
  return path;
}

async function run(path: string, argv: string[], runner?: Parameters<typeof cli>[2]) {
  process.env.REEDAR_STORE = path;
  const lines: string[] = [];
  const code = await cli(argv, (line) => lines.push(line), runner);
  return { code, text: lines.join("\n") };
}

describe("reedar cli", () => {
  test("feeds lists active feeds with unread and star counts", async () => {
    const path = await seed("feeds");
    const { code, text } = await run(path, ["feeds"]);
    expect(code).toBe(0);
    expect(text).toContain("● Test Feed [Tech] 未読1/2");
    expect(text).toContain("https://example.com/rss");
  });

  test("feeds hides removed feeds", async () => {
    const path = await seed("removed");
    const store = await Store.open(path);
    const feed = store.state.feeds[0];
    if (!feed) throw new Error("fixture missing");
    feed.removedAt = new Date().toISOString();
    await store.save();
    const { code, text } = await run(path, ["feeds"]);
    expect(code).toBe(0);
    expect(text).not.toContain("Test Feed");
  });

  test("articles filters unread, feed text, and limit", async () => {
    const path = await seed("articles");
    const unread = await run(path, ["articles", "--unread"]);
    expect(unread.text).toContain("Unread Story");
    expect(unread.text).not.toContain("Read Story");
    const starred = await run(path, ["articles", "--starred"]);
    expect(starred.text).toContain("Read Story");
    expect(starred.text).not.toContain("Unread Story");
    const byFeed = await run(path, ["articles", "--feed", "test"]);
    expect(byFeed.text).toContain("Unread Story");
    const none = await run(path, ["articles", "--feed", "missing"]);
    expect(none.text).toBe("");
    const limited = await run(path, ["articles", "--limit", "1", "--json"]);
    expect(JSON.parse(limited.text)).toHaveLength(1);
  });

  test("article prints full record and errors on unknown id", async () => {
    const path = await seed("article");
    const store = await Store.open(path);
    const id = store.state.articles.find((article) => article.title === "Unread Story")?.id ?? "";
    const found = await run(path, ["article", id]);
    expect(found.code).toBe(0);
    expect(found.text).toContain("Unread Story");
    expect(found.text).toContain("未読");
    const missing = await run(path, ["article", "zzz-nope"]);
    expect(missing.code).toBe(1);
    expect(missing.text).toContain("記事が見つかりません");
  });

  test("summarize sends the article through the agent runner", async () => {
    const path = await seed("summarize");
    const store = await Store.open(path);
    const id = store.state.articles[0]?.id ?? "";
    const captured: string[] = [];
    const { code, text } = await run(path, ["summarize", id, "--agent", "claude"], async (_agent, conversation, _question, _cwd, _signal, emit) => {
      captured.push(conversation.source.title);
      emit({ type: "delta", text: "要約結果" });
    });
    expect(code).toBe(0);
    expect(captured).toEqual(["Unread Story"]);
    expect(text).toBe("要約結果");
  });

  test("reports unreadable library", async () => {
    const { code, text } = await run(join(directory, "missing", "reader.json"), ["feeds"]);
    expect(code).toBe(1);
    expect(text).toContain("ライブラリを読み込めませんでした");
  });
});

describe("cli install", () => {
  test("writes a shim into ~/.local/bin and skill files into agent directories", async () => {
    const home = join(directory, "home");
    const result = await installCli({ home });
    expect(result.bin).toBe(join(home, ".local", "bin", "reedar"));
    const shim = await readFile(result.bin, "utf8");
    expect(shim).toContain("reedar.ts");
    expect((await stat(result.bin)).mode & 0o111).toBeGreaterThan(0);
    expect(result.skills).toHaveLength(3);
    for (const skill of result.skills) {
      const content = await readFile(skill, "utf8");
      expect(content).toContain("name: reedar");
      expect(content).toContain("reedar feeds");
    }
  });

  test("engine cli.install exposes the install in the snapshot", async () => {
    process.env.REEDAR_HOME = join(directory, "engine-home");
    const store = await Store.open(join(directory, "engine", "state.json"));
    const { Engine } = await import("../src/main/engine");
    const engine = new Engine(store, join(directory, "engine", "runner"), { connect: async (agent) => ({ agent, installed: false, status: "unavailable", detail: "" }) });
    await engine.dispatch({ type: "cli.install" });
    expect(engine.snapshot.cliInstall?.bin).toContain("reedar");
    await engine.close();
    delete process.env.REEDAR_HOME;
  });
});
