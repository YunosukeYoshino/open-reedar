import { afterAll, beforeAll, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { App } from "../src/ui/App";
import { parseFeed } from "../src/main/feeds";
import type { Action, Snapshot } from "../src/shared/schema";

const window = new Window();
const saved = new Map<string, PropertyDescriptor | undefined>();
const actions: Action[] = [];
let stream: TestStream | undefined;
let root: Root;
let snapshot: Snapshot;
class TestStream {
  onopen: (() => void) | null = null;
  onmessage: ((message: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor() { stream = this; }
  close() {}
}

beforeAll(async () => {
  for (const [key, value] of Object.entries({ window, document: window.document, navigator: window.navigator, HTMLElement: window.HTMLElement, EventSource: TestStream, IS_REACT_ACT_ENVIRONMENT: true, fetch: async (_url: unknown, init: RequestInit) => { actions.push(JSON.parse(String(init.body))); return new Response('{"ok":true}'); } })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const { createRoot } = await import("react-dom/client");
  const container = window.document.createElement("div");
  window.document.body.append(container);
  root = createRoot(container as unknown as HTMLElement);
  await act(async () => root.render(<App />));
  const parsed = await parseFeed('<rss version="2.0"><channel><title>Test feed</title><link>https://example.com</link><item><guid>one</guid><title>First article</title><description>First body</description></item><item><guid>two</guid><title>Second article</title><description>Second body</description></item></channel></rss>', "https://example.com/rss", null);
  snapshot = { state: { version: 1, language: "en", folders: [], feeds: [parsed.feed], articles: parsed.articles, conversations: [], refreshMinutes: 0, fontSize: "m", articlesRetentionDays: 0 }, connections: [], refreshing: false };
  await act(async () => { stream?.onopen?.(); stream?.onmessage?.({ data: JSON.stringify({ type: "snapshot", snapshot }) }); });
});
afterAll(async () => {
  await act(async () => root.unmount());
  for (const [key, descriptor] of saved) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  await window.happyDOM.close();
});

test("J/K continue article navigation after a row receives keyboard focus", async () => {
  const first = window.document.querySelector('[aria-label="Unread: First article"]');
  if (!(first instanceof window.HTMLButtonElement)) throw new Error("Missing article row");
  await act(async () => { first?.focus(); first?.click(); });
  expect(window.document.querySelector(".article-body h1")?.textContent).toBe("First article");
  await act(async () => first?.dispatchEvent(new window.KeyboardEvent("keydown", { key: "j", bubbles: true })));
  expect(window.document.querySelector(".article-body h1")?.textContent).toBe("Second article");
  expect(actions.filter((action) => action.type === "article.read")).toHaveLength(2);
});

test("typing J into search does not navigate to a different article", async () => {
  const before = window.document.querySelector(".article-body h1")?.textContent;
  const search = window.document.querySelector("input#article-search");
  if (!(search instanceof window.HTMLInputElement)) throw new Error("Missing search input");
  await act(async () => { search?.focus(); search?.dispatchEvent(new window.KeyboardEvent("keydown", { key: "j", bubbles: true })); });
  expect(window.document.querySelector(".article-body h1")?.textContent).toBe(before);
});

test("an authentication-waiting conversation can be cancelled from the panel", async () => {
  const article = snapshot.state.articles[0];
  if (!article) throw new Error("Missing fixture article");
  snapshot.state.conversations.push({ id: "waiting", articleId: article.id, agent: "codex", source: { title: article.title, url: article.url, text: article.text, capturedAt: article.receivedAt }, messages: [{ id: "answer", role: "assistant", text: "", createdAt: article.receivedAt, state: { status: "waiting", reason: "Log in first" } }] });
  await act(async () => stream?.onmessage?.({ data: JSON.stringify({ type: "snapshot", snapshot }) }));
  const first = window.document.querySelector('[aria-label="Unread: First article"]');
  if (!(first instanceof window.HTMLButtonElement)) throw new Error("Missing article row");
  await act(async () => first.click());
  const toggle = window.document.querySelector(".ai-toggle");
  if (!(toggle instanceof window.HTMLButtonElement)) throw new Error("Missing AI toggle");
  await act(async () => toggle.click());
  const cancel = window.document.querySelector('[aria-label="Cancel"]');
  expect(cancel instanceof window.HTMLButtonElement).toBe(true);
  if (!(cancel instanceof window.HTMLButtonElement)) return;
  await act(async () => cancel.click());
  expect(actions.at(-1)).toEqual({ type: "chat.stop", conversationId: "waiting" });
});

test("the conversation list shows the failure reason instead of claiming it is still waiting", async () => {
  const last = snapshot.state.conversations[0]?.messages.at(-1);
  if (last?.role !== "assistant") throw new Error("Missing assistant fixture");
  last.state = { status: "failed", error: "Interrupted on restart" };
  await act(async () => stream?.onmessage?.({ data: JSON.stringify({ type: "snapshot", snapshot }) }));
  expect(window.document.querySelector(".activity-row p")?.textContent).toBe("Interrupted on restart");
});


test("summarizes in the article area, shows the supplied source and restores the excerpt", async () => {
  const article = snapshot.state.articles[1];
  if (!article) throw new Error("Missing fixture article");
  const close = window.document.querySelector('[aria-label="Close AI panel"]');
  if (close instanceof window.HTMLButtonElement) await act(async () => close.click());
  const row = window.document.querySelector('[aria-label="Unread: Second article"]');
  if (!(row instanceof window.HTMLButtonElement)) throw new Error("Missing row");
  await act(async () => row.click());
  const button = window.document.querySelector('[aria-label="Summarize article"]');
  expect(button instanceof window.HTMLButtonElement).toBe(true);
  if (!(button instanceof window.HTMLButtonElement)) return;
  await act(async () => button.click());
  expect(actions.at(-1)).toEqual({ type: "chat.summarize", articleId: article.id, agent: "codex" });
  expect(window.document.querySelector(".ai-panel")).toBeNull();
  snapshot.state.conversations.push({ id: "summary", articleId: article.id, agent: "codex", source: { title: article.title, url: article.url, text: "Complete body including the final conclusion.", origin: "web", capturedAt: article.receivedAt }, messages: [{ id: "summary-answer", role: "assistant", purpose: "summary", sourceOrigin: "web", text: "## 要点\n全文に基づく要約。[危険](javascript:alert(1)) ![tracking](https://example.com/track.png)<script>alert(1)</script>", createdAt: article.receivedAt, state: { status: "completed" } }] });
  await act(async () => stream?.onmessage?.({ data: JSON.stringify({ type: "snapshot", snapshot }) }));
  expect(window.document.querySelector(".reader-summary")?.textContent).toContain("全文に基づく要約");
  expect(window.document.querySelector(".reader-summary")?.textContent).toContain("Linked article");
  expect(window.document.querySelector(".reader-summary details")?.textContent).toContain("final conclusion");
  expect(window.document.querySelector(".reader-summary img, .reader-summary script, .reader-summary a[href^='javascript:']")).toBeNull();
  expect(window.document.querySelector(".article-html")).toBeNull();
  const back = window.document.querySelector('[aria-label="Back to feed text"]');
  if (!(back instanceof window.HTMLButtonElement)) throw new Error("Missing back button");
  await act(async () => back.click());
  expect(window.document.querySelector(".article-html")?.textContent).toBe("Second body");
  const again = window.document.querySelector('[aria-label="Summarize article"]');
  if (!(again instanceof window.HTMLButtonElement)) throw new Error("Missing summary button");
  const count = actions.length;
  await act(async () => again.click());
  expect(actions).toHaveLength(count);
});


test("a removed feed disappears from reading views and can be restored with its articles", async () => {
  const feed = snapshot.state.feeds[0];
  if (!feed) throw new Error("Missing feed fixture");
  const remove = window.document.querySelector('[aria-label="Remove Test feed"]');
  if (!(remove instanceof window.HTMLButtonElement)) throw new Error("Missing remove control");
  await act(async () => remove.click());
  expect(actions.at(-1)).toEqual({ type: "feed.remove", id: feed.id });
  feed.removedAt = new Date().toISOString();
  await act(async () => stream?.onmessage?.({ data: JSON.stringify({ type: "snapshot", snapshot }) }));
  expect(window.document.querySelectorAll(".article-row")).toHaveLength(0);
  expect(window.document.querySelector(".article-body")).toBeNull();
  expect(window.document.querySelector(".sidebar .feed-row")).toBeNull();
  const restore = window.document.querySelector('[aria-label="Restore Test feed"]');
  if (!(restore instanceof window.HTMLButtonElement)) throw new Error("Missing restore control");
  await act(async () => restore.click());
  expect(actions.at(-1)).toEqual({ type: "feed.restore", id: feed.id });
  delete feed.removedAt;
  await act(async () => stream?.onmessage?.({ data: JSON.stringify({ type: "snapshot", snapshot }) }));
  expect(window.document.querySelectorAll(".article-row")).toHaveLength(2);
  expect(window.document.querySelector(".sidebar .feed-row")?.textContent).toContain("Test feed");
});


test("OPML controls upload a selected file, display per-feed results, and stop an import", async () => {
  const input = window.document.querySelector('#opml-file');
  expect(input instanceof window.HTMLInputElement).toBe(true);
  if (!(input instanceof window.HTMLInputElement)) return;
  const xml = '<opml version="2.0"><head/><body><outline text="Imported" xmlUrl="https://example.org/rss"/></body></opml>';
  const file = new window.File([xml], "subscriptions.opml", { type: "text/xml" });
  Object.defineProperty(input, "files", { configurable: true, value: [file] });
  await act(async () => input.dispatchEvent(new window.Event("change", { bubbles: true })));
  const form = window.document.querySelector('#opml-dialog form');
  if (!(form instanceof window.HTMLFormElement)) throw new Error("Missing OPML form");
  await act(async () => form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true })));
  expect(actions.at(-1)).toEqual({ type: "opml.preview", xml });
  snapshot.opmlPreview = { entries: [{ url: "https://example.org/rss", title: "Imported", folderName: null, resolution: "new" }], missingFeeds: [] };
  await act(async () => stream?.onmessage?.({ data: JSON.stringify({ type: "snapshot", snapshot }) }));
  const apply = [...window.document.querySelectorAll('#opml-dialog button')].find((button) => button.textContent?.includes("Import"));
  if (!(apply instanceof window.HTMLButtonElement)) throw new Error("Missing OPML apply control");
  await act(async () => apply.click());
  expect(actions.at(-1)).toEqual({ type: "opml.import", xml, urls: ["https://example.org/rss"] });
  delete snapshot.opmlPreview;
  snapshot.opmlImport = { status: "running", total: 3, results: [{ id: "duplicate", title: "Duplicate", url: "https://example.com/rss", status: "skipped", detail: "登録済みです。" }, { id: "blocked", title: "Blocked", url: "http://127.0.0.1/rss", status: "failed", detail: "公開HTTP/HTTPSのフィードURLではありません。" }] };
  await act(async () => stream?.onmessage?.({ data: JSON.stringify({ type: "snapshot", snapshot }) }));
  expect(window.document.querySelector('#opml-dialog')?.textContent).toContain("登録済みです。");
  expect(window.document.querySelector('#opml-dialog')?.textContent).toContain("公開HTTP/HTTPS");
  expect(window.document.querySelector('#opml-dialog progress')?.getAttribute('value')).toBe("2");
  const stop = window.document.querySelector('[aria-label="Stop the OPML import"]');
  if (!(stop instanceof window.HTMLButtonElement)) throw new Error("Missing OPML stop control");
  await act(async () => stop.click());
  expect(actions.at(-1)).toEqual({ type: "opml.stop" });
  const download = window.document.querySelector('#opml-dialog a[download]');
  expect(download?.getAttribute("href")).toBe("/api/opml");
  snapshot.opmlImport.status = "cancelled";
  await act(async () => stream?.onmessage?.({ data: JSON.stringify({ type: "snapshot", snapshot }) }));
});


test("OPML preview applies only selected feeds and removes missing ones after confirmation", async () => {
  const dialog = window.document.querySelector('#opml-dialog');
  if (!(dialog instanceof window.HTMLElement)) throw new Error("Missing OPML dialog");
  const input = dialog.querySelector('#opml-file');
  const form = dialog.querySelector('form');
  if (!(input instanceof window.HTMLInputElement) || !(form instanceof window.HTMLFormElement)) throw new Error("Missing OPML form");
  const xml = '<opml version="2.0"><body><outline text="A" xmlUrl="https://a.example.com/rss"/><outline text="B" xmlUrl="https://b.example.com/rss"/></body></opml>';
  Object.defineProperty(input, "files", { configurable: true, value: [new window.File([xml], "feeds.opml")] });
  await act(async () => form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true })));
  expect(actions.at(-1)).toEqual({ type: "opml.preview", xml });
  snapshot.opmlPreview = {
    entries: [
      { url: "https://a.example.com/rss", title: "Feed A", folderName: "Tech", resolution: "new" },
      { url: "https://b.example.com/rss", title: "Feed B", folderName: null, resolution: "new" },
      { url: "https://example.com/rss", title: "Test feed", folderName: null, resolution: "duplicate" },
    ],
    missingFeeds: [{ id: "feed-missing", title: "Missing", url: "https://missing.example.com/rss", folderName: null }],
  };
  await act(async () => stream?.onmessage?.({ data: JSON.stringify({ type: "snapshot", snapshot }) }));
  const boxes = [...dialog.querySelectorAll(".opml-preview > .opml-preview-list input[type=checkbox]")];
  expect(boxes.map((box) => box instanceof window.HTMLInputElement ? [box.checked, box.disabled] : "not-input")).toEqual([[true, false], [true, false], [false, true]]);
  const feedB = boxes[1];
  if (!(feedB instanceof window.HTMLInputElement)) throw new Error("Missing checkbox");
  await act(async () => feedB.click());
  const apply = [...dialog.querySelectorAll("button")].find((button) => button.textContent?.includes("Import"));
  if (!(apply instanceof window.HTMLButtonElement)) throw new Error("Missing apply button");
  await act(async () => apply.click());
  expect(actions.at(-1)).toEqual({ type: "opml.import", xml, urls: ["https://a.example.com/rss"], folders: { "https://a.example.com/rss": "Tech" } });
  const missingBox = dialog.querySelector(".opml-missing input[type=checkbox]");
  if (!(missingBox instanceof window.HTMLInputElement)) throw new Error("Missing missing-feed checkbox");
  await act(async () => missingBox.click());
  const remove = [...dialog.querySelectorAll("button")].find((button) => button.textContent?.includes("Remove") && button.textContent?.includes("selected"));
  if (!(remove instanceof window.HTMLButtonElement)) throw new Error("Missing remove button");
  await act(async () => remove.click());
  const confirm = [...dialog.querySelectorAll("button")].find((button) => button.textContent === "Remove");
  if (!(confirm instanceof window.HTMLButtonElement)) throw new Error("Missing confirm button");
  await act(async () => confirm.click());
  expect(actions.at(-1)).toEqual({ type: "feed.remove", id: "feed-missing" });
  delete snapshot.opmlPreview;
  await act(async () => stream?.onmessage?.({ data: JSON.stringify({ type: "snapshot", snapshot }) }));
});


test("organize dialog proposes an AI plan and applies the selected moves", async () => {
  const dialog = window.document.querySelector('#organize-dialog');
  if (!(dialog instanceof window.HTMLElement)) throw new Error("Missing organize dialog");
  snapshot.connections = [{ agent: "codex", installed: true, status: "ready", detail: "fixture" }];
  await act(async () => stream?.onmessage?.({ data: JSON.stringify({ type: "snapshot", snapshot }) }));
  const propose = [...dialog.querySelectorAll("button")].find((button) => button.textContent?.includes("AI plan"));
  if (!(propose instanceof window.HTMLButtonElement)) throw new Error("Missing propose button");
  await act(async () => propose.click());
  expect(actions.at(-1)).toEqual({ type: "organize.propose", agent: "codex", scope: "library" });
  const feed = snapshot.state.feeds[0];
  if (!feed) throw new Error("Missing feed fixture");
  snapshot.organize = { scope: "library", agent: "codex", status: "completed", startedAt: new Date().toISOString(), plan: { moves: [{ feedId: feed.id, title: feed.title, folderName: "Tech", newFolder: true }], assignments: [] } };
  await act(async () => stream?.onmessage?.({ data: JSON.stringify({ type: "snapshot", snapshot }) }));
  const move = dialog.querySelector(".organize-ai .opml-preview-list input[type=checkbox]");
  if (!(move instanceof window.HTMLInputElement)) throw new Error("Missing move checkbox");
  expect(move.checked).toBe(true);
  expect(dialog.querySelector(".organize-ai .opml-entry-detail")?.textContent).toContain("Tech");
  const apply = [...dialog.querySelectorAll("button")].find((button) => button.textContent?.includes("Apply") && button.textContent?.includes("selected"));
  if (!(apply instanceof window.HTMLButtonElement)) throw new Error("Missing apply button");
  await act(async () => apply.click());
  expect(actions.at(-1)).toEqual({ type: "organize.apply", moves: [{ feedId: feed.id, folderName: "Tech" }] });
  delete snapshot.organize;
  await act(async () => stream?.onmessage?.({ data: JSON.stringify({ type: "snapshot", snapshot }) }));
});

test("OPML preview asks AI for folder assignments and applies them", async () => {
  const dialog = window.document.querySelector('#opml-dialog');
  if (!(dialog instanceof window.HTMLElement)) throw new Error("Missing OPML dialog");
  snapshot.opmlPreview = { entries: [{ url: "https://a.example.com/rss", title: "Feed A", folderName: null, resolution: "new" }], missingFeeds: [] };
  await act(async () => stream?.onmessage?.({ data: JSON.stringify({ type: "snapshot", snapshot }) }));
  const suggest = [...dialog.querySelectorAll("button")].find((button) => button.textContent?.includes("AI folder"));
  if (!(suggest instanceof window.HTMLButtonElement)) throw new Error("Missing suggest button");
  await act(async () => suggest.click());
  expect(actions.at(-1)).toEqual({ type: "organize.propose", agent: "codex", scope: "opml" });
  snapshot.organize = { scope: "opml", agent: "codex", status: "completed", startedAt: new Date().toISOString(), plan: { moves: [], assignments: [{ url: "https://a.example.com/rss", title: "Feed A", folderName: "News" }] } };
  await act(async () => stream?.onmessage?.({ data: JSON.stringify({ type: "snapshot", snapshot }) }));
  expect(dialog.textContent).toContain("assignments");
  const apply = [...dialog.querySelectorAll(".organize-banner button")].find((button) => button.textContent === "Apply");
  if (!(apply instanceof window.HTMLButtonElement)) throw new Error("Missing apply button");
  await act(async () => apply.click());
  expect(actions.at(-1)).toEqual({ type: "organize.apply", assignments: [{ url: "https://a.example.com/rss", folderName: "News" }] });
  delete snapshot.organize;
  delete snapshot.opmlPreview;
  snapshot.connections = [];
  await act(async () => stream?.onmessage?.({ data: JSON.stringify({ type: "snapshot", snapshot }) }));
});

test("OPML upload rejects invalid UTF-8 without sending mangled folder names", async () => {
  const input = window.document.querySelector('#opml-file');
  const form = window.document.querySelector('#opml-dialog form');
  if (!(input instanceof window.HTMLInputElement) || !(form instanceof window.HTMLFormElement)) throw new Error("Missing OPML form");
  const file = new window.File([new Uint8Array([0xff, 0xfe, 0xff])], "invalid.opml");
  Object.defineProperty(input, "files", { configurable: true, value: [file] });
  await act(async () => input.dispatchEvent(new window.Event("change", { bubbles: true })));
  const before = actions.length;
  await act(async () => form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true })));
  expect(actions).toHaveLength(before);
  expect(window.document.querySelector('#opml-error')?.textContent).toContain("UTF-8");
});
