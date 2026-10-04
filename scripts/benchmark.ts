// Deterministic synthetic-library benchmark for the persistence and snapshot paths.
// Dev tool only: wired up as `bun run benchmark`, never bundled into the app.
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine } from "../src/main/engine";
import { Store } from "../src/main/store";
import { stateSchema } from "../src/shared/schema";
import type { Article, Conversation, Feed, ReaderState } from "../src/shared/schema";

const SIZES = [1_000, 10_000, 50_000];
const FEED_COUNT = 30;

// mulberry32 — fixed seed so every run produces byte-identical libraries.
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const random = mulberry32(0x5eed5eed);
// Deterministic base instant — the seed alone must fix every timestamp or the fixture is not reproducible.
const BASE = Date.parse("2026-09-01T00:00:00Z");
const int = (low: number, high: number) => low + Math.floor(random() * (high - low + 1));
const pick = <T>(items: readonly T[]): T => items[int(0, items.length - 1)]!;
let nextId = 0;
const hexId = () => (nextId++).toString(16).padStart(24, "0");

const WORDS = "the quick brown fox jumps over a lazy dog while engineers ship incremental reader updates to production feeds and subscribers skim headlines during breakfast coffee before standup notes land in the queue for review publish atom xml parser cache latency memory snapshot render scroll archive unread starred folder digest summary weekly daily hourly metrics latency throughput benchmark profile heap garbage collection event loop dispatch engine store schema validate serialize persist refresh backoff network retry digest conversation assistant model agent runner workspace sidebar toolbar theme token session cookie stream chunk delta".split(" ");

function sentence() {
  const words = Array.from({ length: int(6, 14) }, () => pick(WORDS));
  return `${words.join(" ")}.`;
}

function paragraph() {
  return Array.from({ length: int(2, 5) }, sentence).join(" ");
}

function body() {
  const text = Array.from({ length: int(6, 40) }, paragraph).join("\n\n");
  const html = text.split("\n\n").map((part) => `<p>${part}</p>`).join("");
  return { text, html };
}

const folders = Array.from({ length: 6 }, (_, index) => ({ id: hexId(), name: `Folder ${index}` }));

function makeFeed(index: number): Feed {
  const url = `https://feed-${index}.example.com/rss.xml`;
  const feed: Feed = {
    id: hexId(), url, title: `${pick(WORDS)} ${pick(WORDS)} daily`, siteUrl: `https://feed-${index}.example.com`,
    folderId: random() < 0.8 ? pick(folders).id : null,
    updatedAt: new Date(BASE - int(0, 86_400_000)).toISOString(), error: null,
  };
  if (random() < 0.6) feed.etag = `W/"v${int(1, 9999)}"`;
  if (random() < 0.6) feed.lastModified = new Date(BASE - int(0, 3_600_000)).toISOString();
  if (random() < 0.15) feed.failures = int(1, 4);
  if (feed.failures) feed.backoffUntil = new Date(BASE + int(0, 3_600_000)).toISOString();
  return feed;
}

function makeArticle(feedId: string, now: number): Article {
  const { text, html } = body();
  const publishedAt = new Date(now - int(0, 45_000_000_000)).toISOString(); // ~1.4 years of backlog
  const article: Article = {
    id: hexId(), feedId, title: sentence().slice(0, int(20, 110)), url: `https://example.com/articles/${hexId()}`,
    author: random() < 0.7 ? `${pick(WORDS)} ${pick(WORDS)}` : "",
    publishedAt, receivedAt: new Date(new Date(publishedAt).getTime() + int(0, 3_600_000)).toISOString(),
    html, text, excerpt: text.replace(/\s+/g, " ").slice(0, 180),
    imageUrl: random() < 0.4 ? `https://images.example.com/${hexId()}.png` : null,
    read: random() < 0.6, starred: random() < 0.05,
  };
  if (random() < 0.1) article.readerText = text;
  if (random() < 0.1) article.readerHtml = html;
  if (random() < 0.05) article.note = paragraph().slice(0, 400);
  if (random() < 0.05) article.highlights = Array.from({ length: int(1, 4) }, () => paragraph().slice(0, 300));
  return article;
}

function generate(size: number): ReaderState {
  const feeds = Array.from({ length: FEED_COUNT }, (_, index) => makeFeed(index));
  const weights = feeds.map(() => random() * random() + 0.02);
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  const cumulative = weights.map((_, index) => weights.slice(0, index + 1).reduce((sum, weight) => sum + weight, 0) / total);
  const pickFeed = () => {
    const roll = random();
    return feeds[cumulative.findIndex((mark) => roll <= mark)] ?? feeds[0]!;
  };
  const now = BASE;
  const articles = Array.from({ length: size }, () => makeArticle(pickFeed().id, now))
    .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
  const conversations: Conversation[] = articles.slice(0, 4).map((article) => ({
    id: hexId(), articleId: article.id, agent: "codex",
    source: { title: article.title, url: article.url, text: article.text, capturedAt: article.receivedAt },
    messages: [{ id: hexId(), role: "user" as const, text: "Summarize this.", createdAt: article.receivedAt }],
  }));
  return { version: 1, folders, feeds, articles, conversations, language: "en", refreshMinutes: 30, fontSize: "m", articlesRetentionDays: 0 };
}

// A feed refresh returns only the newest ~2 dozen items: mostly known ids plus a few new ones.
function refreshedBatch(store: Store, feed: Feed, now: number): Article[] {
  const existing = store.state.articles.filter((article) => article.feedId === feed.id).slice(0, 18);
  const mutated = existing.map((article) => ({ ...article }));
  for (let index = 0; index < 6; index++) mutated.push({ ...makeArticle(feed.id, now), publishedAt: new Date(now + index).toISOString() });
  return mutated;
}

function sampleRss() {
  let peak = process.memoryUsage().rss;
  const timer = setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss); }, 4);
  timer.unref();
  return () => { clearInterval(timer); return Math.max(peak, process.memoryUsage().rss); };
}

const median = (samples: number[]) => [...samples].sort((a, b) => a - b)[Math.floor(samples.length / 2)]!;

const times = new Map<string, number[]>();
const peaks = new Map<string, number[]>();
const fileSizes: number[] = [];
const ROWS = ["readFile", "JSON.parse", "zod validate", "Store.open", "store.save", "snapshot", "mergeFeed x1", "mergeFeed x30"];

async function measure<T>(label: string, reps: number, fn: (rep: number) => T | Promise<T>) {
  const samples: number[] = [];
  let peak = 0;
  let result: T | undefined;
  for (let rep = 0; rep < reps; rep++) {
    Bun.gc(true);
    const stop = sampleRss();
    const started = performance.now();
    result = await fn(rep);
    samples.push(performance.now() - started);
    peak = Math.max(peak, stop());
  }
  times.get(label)!.push(median(samples));
  peaks.get(label)!.push(Math.round(peak / 1_048_576));
  return result as T;
}

const directory = await mkdtemp(join(tmpdir(), "reedar-benchmark-"));
try {
  for (const row of ROWS) { times.set(row, []); peaks.set(row, []); }
  for (const size of SIZES) {
    console.error(`benchmarking ${size.toLocaleString()} articles...`);
    const libraryDirectory = join(directory, String(size));
    await mkdir(libraryDirectory);
    const path = join(libraryDirectory, "reader.json");
    {
      const state = stateSchema.parse(generate(size));
      const started = performance.now();
      const json = JSON.stringify(state);
      await writeFile(path, json, { mode: 0o600 });
      console.error(`  generated + wrote fixture in ${Math.round(performance.now() - started)}ms`);
      fileSizes.push(json.length / 1_048_576);
    }
    // Fixture objects are out of scope before measuring so generation heap does not inflate phase peaks.
    Bun.gc(true);
    {
      const text = await measure("readFile", 2, () => readFile(path, "utf8"));
      const parsed = await measure("JSON.parse", 2, () => JSON.parse(text));
      await measure("zod validate", 2, () => stateSchema.parse(parsed));
    }
    Bun.gc(true);
    const store = await measure("Store.open", 1, () => Store.open(path));
    await measure("store.save", 2, () => store.save());

    const engine = new Engine(store, join(directory, `runner-${size}`));
    await measure("snapshot", 3, () => JSON.stringify({ type: "snapshot", snapshot: engine.snapshot }));

    const refresh = store.state.feeds.map((feed) => [feed, refreshedBatch(store, feed, BASE)] as const);
    const savedArticles = store.state.articles;
    await measure("mergeFeed x1", 3, (rep) => {
      if (rep) store.state.articles = savedArticles;
      const [feed, batch] = refresh[0]!;
      store.mergeFeed(feed, batch);
    });
    store.state.articles = savedArticles;
    await measure("mergeFeed x30", 1, () => {
      for (const [feed, batch] of refresh) store.mergeFeed(feed, batch);
    });
    await engine.close();
  }
} finally {
  const status = await Bun.spawn(["trash", directory]).exited;
  if (status !== 0) throw new Error(`Benchmark cleanup failed (${status})`);
}

function table(unit: string, values: Map<string, number[]> | number[]) {
  const widths = SIZES.map((size) => `${size / 1_000}k`.length + 9);
  const cell = (value: number, index: number) => value.toFixed(value >= 100 ? 0 : 1).padStart(widths[index]!);
  const lines = ["phase".padEnd(16) + SIZES.map((size, index) => `${`${size / 1_000}k`} (${unit})`.padStart(widths[index]!)).join("")];
  if (values instanceof Map) for (const row of ROWS) lines.push(row.padEnd(16) + values.get(row)!.map(cell).join(""));
  else lines.push("reader.json".padEnd(16) + values.map(cell).join(""));
  return lines.join("\n");
}

console.log(`\n${table("MB", fileSizes)}\n\n${table("ms", times)}\n\n${table("MB", peaks)}\n`);
