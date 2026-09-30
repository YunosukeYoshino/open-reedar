import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";
import { actionSchema } from "../shared/schema";
import { Engine } from "./engine";
import { fetchPublic } from "./network";
import { serializeOpml } from "./opml";
import { Store } from "./store";
import { t } from "../shared/i18n";

type Options = { dataDirectory: string; staticDirectory: string; port?: number; engine?: Engine };
const csp = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; frame-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";
const contentTypes: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2" };

function json(response: ServerResponse, status: number, value: unknown) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(value));
}

function matchesToken(received: string | undefined, token: string) {
  if (!received) return false;
  const input = Buffer.from(received);
  const expected = Buffer.from(token);
  return input.length === expected.length && timingSafeEqual(input, expected);
}

export async function requestBody(request: AsyncIterable<unknown>, maximumBytes = 32_000) {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    if (!Buffer.isBuffer(chunk)) throw new Error(t("en", "err.badInput"));
    length += chunk.length;
    if (length > maximumBytes) throw new Error(t("en", "err.inputTooLarge"));
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

export async function startServer(options: Options) {
  const store = options.engine?.store ?? await Store.open(join(options.dataDirectory, "reader.json"));
  const engine = options.engine ?? new Engine(store, join(options.dataDirectory, "reading-workspace"));
  const token = randomBytes(32).toString("hex");
  let origin = "";
  const streams = new Set<ServerResponse>();
  const images = new Map<string, { body: Buffer; contentType: string }>();
  let imageBytes = 0;

  const server = createServer((request, response) => {
    response.setHeader("Content-Security-Policy", csp);
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("Cache-Control", "no-store");
    void handle(request, response).catch((error: unknown) => {
      if (response.headersSent) { response.end(); return; }
      json(response, 400, { error: error instanceof Error ? error.message : t(store.state.language, "err.requestFailed") });
    });
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;

  async function handle(request: IncomingMessage, response: ServerResponse) {
    if (!origin || request.headers.host !== new URL(origin).host) return json(response, 403, { error: t(store.state.language, "err.forbiddenHost") });
    const url = new URL(request.url ?? "/", origin);
    if (request.method === "GET" && url.pathname === "/" && matchesToken(url.searchParams.get("key") ?? undefined, token)) {
      response.writeHead(303, { Location: "/", "Set-Cookie": `reedar_session=${token}; HttpOnly; SameSite=Strict; Path=/` });
      response.end();
      return;
    }
    const cookie = request.headers.cookie?.split(";").map((value) => value.trim()).find((value) => value.startsWith("reedar_session="))?.slice("reedar_session=".length);
    if (!matchesToken(cookie, token)) return json(response, 401, { error: t(store.state.language, "err.openFromLaunchUrl") });
    if (request.headers.origin && request.headers.origin !== origin) return json(response, 403, { error: t(store.state.language, "err.externalAction") });

    if (request.method === "GET" && url.pathname === "/api/state") return json(response, 200, engine.snapshot);
    if (request.method === "GET" && url.pathname === "/api/opml") {
      response.writeHead(200, { "Content-Type": "text/x-opml; charset=utf-8", "Content-Disposition": 'attachment; filename="Reedar.opml"' });
      response.end(serializeOpml(store.state.feeds, store.state.folders));
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/action") {
      if (request.headers.origin !== origin || !request.headers["content-type"]?.startsWith("application/json")) return json(response, 403, { error: t(store.state.language, "err.externalAction") });
      const result = actionSchema.safeParse(await requestBody(request, 33 * 1024 * 1024));
      if (!result.success) return json(response, 400, { error: t(store.state.language, "err.checkInput") });
      const outcome = await engine.dispatch(result.data);
      return json(response, 200, outcome === undefined ? { ok: true } : { ok: true, result: outcome });
    }
    if (request.method === "GET" && url.pathname === "/api/events") {
      response.writeHead(200, { "Content-Type": "text/event-stream", Connection: "keep-alive", "X-Accel-Buffering": "no" });
      response.write(`data: ${JSON.stringify({ type: "snapshot", snapshot: engine.snapshot })}\n\n`);
      streams.add(response);
      const unsubscribe = engine.subscribe((update) => {
        if (response.writableLength > 2 * 1024 * 1024) { response.end(); return; }
        response.write(`data: ${JSON.stringify(update)}\n\n`);
      });
      const heartbeat = setInterval(() => response.write(": keep-alive\n\n"), 15_000);
      request.on("close", () => { clearInterval(heartbeat); unsubscribe(); streams.delete(response); });
      return;
    }
    if (request.method === "GET" && url.pathname === "/image") {
      const image = url.searchParams.get("url") ?? "";
      const encoded = `/image?url=${encodeURIComponent(image)}`;
      if (!image || image.length > 2048 || !store.state.articles.some((article) => article.imageUrl === image || article.html.includes(encoded) || article.readerHtml?.includes(encoded))) return json(response, 404, { error: t(store.state.language, "err.imageMissing") });
      let result = images.get(image);
      if (!result) {
        const fetched = await fetchPublic(image, 0, undefined, store.state.language);
        const contentType = fetched.contentType.split(";")[0]?.trim() ?? "";
        if (!["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif"].includes(contentType)) return json(response, 415, { error: t(store.state.language, "err.imageType") });
        result = { body: fetched.body, contentType };
        while (imageBytes + result.body.length > 16 * 1024 * 1024 && images.size) {
          const oldest = images.entries().next().value;
          if (!oldest) break;
          imageBytes -= oldest[1].body.length;
          images.delete(oldest[0]);
        }
        images.set(image, result);
        imageBytes += result.body.length;
      }
      response.writeHead(200, { "Content-Type": result.contentType, "Cache-Control": "private, max-age=3600" });
      response.end(result.body);
      return;
    }
    if (request.method !== "GET") return json(response, 405, { error: t(store.state.language, "err.methodNotAllowed") });
    const root = resolve(options.staticDirectory);
    const filename = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname.slice(1));
    const path = resolve(root, filename);
    if (!path.startsWith(root + sep)) return json(response, 403, { error: t(store.state.language, "err.accessDenied") });
    try {
      const body = await readFile(path);
      response.writeHead(200, { "Content-Type": contentTypes[extname(path)] ?? "application/octet-stream" });
      response.end(body);
    } catch { json(response, 404, { error: t(store.state.language, "err.pageMissing") }); }
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error(t(store.state.language, "err.listenFailed"));
  origin = `http://127.0.0.1:${address.port}`;
  if (!options.engine) void engine.initialize().catch(() => {});
  return {
    engine, origin, url: `${origin}/?key=${token}`,
    close: async () => {
      for (const response of streams) response.end();
      const closed = new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      server.closeIdleConnections();
      await engine.close();
      await closed;
    },
  };
}
