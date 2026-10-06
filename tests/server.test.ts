import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";
import { Engine } from "../src/main/engine";
import { Store } from "../src/main/store";
import { requestBody, startServer } from "../src/main/server";

const directory = await mkdtemp(join(tmpdir(), "reedar-http-test-"));
let runtime: Awaited<ReturnType<typeof startServer>>;
let cookie = "";
beforeAll(async () => {
  const assets = join(directory, "assets");
  await mkdir(assets);
  await writeFile(join(assets, "index.html"), "<!doctype html><title>Reedar test</title>");
  await writeFile(join(directory, "private.txt"), "PRIVATE CANARY");
  const pluginDirectory = join(directory, "plugins", "word-count");
  await mkdir(pluginDirectory, { recursive: true });
  await writeFile(join(pluginDirectory, "plugin.toml"), 'name = "word-count"\ntype = "panel"\npermissions = ["articles.read", "net:api.example.com"]\n');
  await writeFile(join(pluginDirectory, "index.html"), "<title>word-count plugin</title>");
  const store = await Store.open(join(directory, "state.json"));
  const engine = new Engine(store, join(directory, "runner"), {
    fetchArticleText: async () => { throw new Error("no fixture article"); },
    run: async () => {}, fetchFeed: async () => { throw new Error("no fixture feeds"); },
    connect: async (agent) => ({ agent, installed: false, status: "unavailable", detail: "fixture" }),
  });
  await engine.initialize();
  runtime = await startServer({ dataDirectory: directory, staticDirectory: assets, engine });
  const response = await fetch(runtime.url, { redirect: "manual" });
  cookie = response.headers.get("set-cookie")?.split(";")[0] ?? "";
});
afterAll(async () => { await runtime.close(); await Bun.spawn(["trash", directory]).exited; });

describe("local reader boundary", () => {
  test("requires a private session, sets an HttpOnly cookie, and removes the launch token from navigation", async () => {
    expect((await fetch(`${runtime.origin}/api/state`)).status).toBe(401);
    const bootstrap = await fetch(runtime.url, { redirect: "manual" });
    expect(bootstrap.status).toBe(303);
    expect(bootstrap.headers.get("set-cookie")).toContain("HttpOnly; SameSite=Strict");
    expect(bootstrap.headers.get("location")).toBe("/");
    const page = await fetch(runtime.origin, { headers: { Cookie: cookie } });
    expect(page.status).toBe(200);
    expect(page.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(page.headers.get("referrer-policy")).toBe("no-referrer");
  });
  test("rejects cross-origin mutations and DNS rebinding without changing state", async () => {
    const action = JSON.stringify({ type: "folder.save", id: null, name: "Attack" });
    const crossOrigin = await fetch(`${runtime.origin}/api/action`, { method: "POST", headers: { Cookie: cookie, Origin: "https://attacker.example", "Content-Type": "application/json" }, body: action });
    expect(crossOrigin.status).toBe(403);
    const rebinding = await fetch(`${runtime.origin}/api/state`, { headers: { Cookie: cookie, Host: "attacker.example" } });
    expect(rebinding.status).toBe(403);
    expect(runtime.engine.store.state.folders).toHaveLength(0);
  });
  test("validates actions and persists an authorized folder change", async () => {
    const headers = { Cookie: cookie, Origin: runtime.origin, "Content-Type": "application/json" };
    const bad = await fetch(`${runtime.origin}/api/action`, { method: "POST", headers, body: JSON.stringify({ type: "folder.save", id: null, name: "" }) });
    expect(bad.status).toBe(400);
    const good = await fetch(`${runtime.origin}/api/action`, { method: "POST", headers, body: JSON.stringify({ type: "folder.save", id: null, name: "Design" }) });
    expect(good.status).toBe(200);
    expect(runtime.engine.store.state.folders[0]?.name).toBe("Design");
  });
  test("does not expose outside files or act as a general image proxy", async () => {
    const outside = await fetch(`${runtime.origin}/%252e%252e/private.txt`, { headers: { Cookie: cookie } });
    expect(await outside.text()).not.toContain("PRIVATE CANARY");
    const proxy = await fetch(`${runtime.origin}/image?url=https://example.com/unknown.jpg`, { headers: { Cookie: cookie } });
    expect(proxy.status).toBe(404);
  });
  test("preserves Japanese input split across network chunks", async () => {
    const body = Buffer.from(JSON.stringify({ type: "folder.save", id: null, name: "日本語" }));
    const split = body.indexOf(Buffer.from("日")) + 1;
    async function* chunks() { yield body.subarray(0, split); yield body.subarray(split); }
    expect(await requestBody(chunks())).toEqual({ type: "folder.save", id: null, name: "日本語" });
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const pending = request(`${runtime.origin}/api/action`, { method: "POST", headers: { Cookie: cookie, Origin: runtime.origin, "Content-Type": "application/json" } }, (response) => { response.resume(); response.on("end", () => resolve(response.statusCode)); });
      pending.on("error", reject);
      pending.write(body.subarray(0, split));
      setTimeout(() => pending.end(body.subarray(split)), 15);
    });
    expect(status).toBe(200);
    expect(runtime.engine.store.state.folders.at(-1)?.name).toBe("日本語");
  });
  test("exports only active subscriptions through the authenticated download endpoint", async () => {
    expect((await fetch(`${runtime.origin}/api/opml`)).status).toBe(401);
    runtime.engine.store.state.feeds.push({ id: "opml", url: "https://example.com/rss?a=1&b=2", title: "News & updates", siteUrl: "https://example.com", folderId: null, updatedAt: null, error: null });
    runtime.engine.store.state.feeds.push({ id: "removed", url: "https://example.com/removed", title: "Removed", siteUrl: "https://example.com", folderId: null, updatedAt: null, error: null, removedAt: "now" });
    const response = await fetch(`${runtime.origin}/api/opml`, { headers: { Cookie: cookie } });
    expect(response.headers.get("content-disposition")).toContain('filename="Reedar.opml"');
    const body = await response.text();
    expect(body).toContain("https://example.com/rss?a=1&amp;b=2");
    expect(body).not.toContain("https://example.com/removed");
  });

  test("accepts a bounded OPML file larger than the ordinary form-body limit", async () => {
    const xml = `<opml version="2.0"><head><title>${"x".repeat(40_000)}</title></head><body/></opml>`;
    const response = await fetch(`${runtime.origin}/api/action`, { method: "POST", headers: { Cookie: cookie, Origin: runtime.origin, "Content-Type": "application/json" }, body: JSON.stringify({ type: "opml.import", xml }) });
    expect(response.status).toBe(200);
    await runtime.engine.settle();
    expect(runtime.engine.snapshot.opmlImport?.status).toBe("completed");
  });

  test("rejects malformed Unicode launch keys as unauthenticated", async () => {
    const response = await fetch(`${runtime.origin}/?key=${encodeURIComponent("é".repeat(64))}`);
    expect(response.status).toBe(401);
  });
  test("serves panel plugin files under a scoped CSP only inside the plugin directory", async () => {
    expect(runtime.engine.snapshot.plugins?.[0]).toMatchObject({ name: "word-count", status: "ready" });
    const page = await fetch(`${runtime.origin}/plugins/word-count/index.html`, { headers: { Cookie: cookie } });
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("word-count plugin");
    const policy = page.headers.get("content-security-policy") ?? "";
    expect(policy).toContain("default-src 'none'");
    expect(policy).toContain("script-src 'self'");
    expect(policy).toContain("connect-src 'self' api.example.com");
    const escape = await fetch(`${runtime.origin}/plugins/word-count/%2e%2e%2fprivate.txt`, { headers: { Cookie: cookie } });
    expect(escape.status).toBe(403);
    expect(await escape.text()).not.toContain("PRIVATE CANARY");
    expect((await fetch(`${runtime.origin}/plugins/unknown/index.html`, { headers: { Cookie: cookie } })).status).toBe(404);
    expect((await fetch(`${runtime.origin}/plugins/word-count/missing.js`, { headers: { Cookie: cookie } })).status).toBe(404);
    expect((await fetch(`${runtime.origin}/plugins/word-count/index.html`)).status).toBe(401);
  });
  test("streams the current snapshot through authenticated SSE", async () => {
    const controller = new AbortController();
    const response = await fetch(`${runtime.origin}/api/events`, { headers: { Cookie: cookie }, signal: controller.signal });
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    const reader = response.body?.getReader();
    const chunk = await reader?.read();
    expect(new TextDecoder().decode(chunk?.value)).toContain('"type":"snapshot"');
    await reader?.cancel();
    controller.abort();
  });
});
