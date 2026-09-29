import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import ipaddr from "ipaddr.js";
import { t } from "../shared/i18n";
import type { Language } from "../shared/schema";

const MAX_BYTES = 5 * 1024 * 1024;

export function publicUrl(value: string, lang: Language = "en") {
  const url = new URL(value);
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) {
    throw new Error(t(lang, "err.badUrlAuth"));
  }
  if (url.port && !["80", "443"].includes(url.port)) {
    throw new Error(t(lang, "err.nonStandardPort"));
  }
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || !host.includes(".")) {
    throw new Error(t(lang, "err.localUrl"));
  }
  if (ipaddr.isValid(host) && !isPublicAddress(host)) {
    throw new Error(t(lang, "err.localUrl"));
  }
  url.hash = "";
  return url;
}

export function isPublicAddress(address: string) {
  try { return ipaddr.process(address).range() === "unicast"; }
  catch { return false; }
}

export async function fetchPublic(value: string, redirects = 0, signal?: AbortSignal, lang: Language = "en", requestHeaders?: Record<string, string>): Promise<{ body: Buffer; url: string; contentType: string; etag?: string; lastModified?: string; notModified?: boolean }> {
  signal?.throwIfAborted();
  const url = publicUrl(value, lang);
  const addresses = await lookup(url.hostname.replace(/^\[|\]$/g, ""), { all: true });
  signal?.throwIfAborted();
  if (addresses.length === 0 || addresses.some((address) => !isPublicAddress(address.address))) {
    throw new Error(t(lang, "err.notPublic"));
  }
  const address = addresses[0];
  if (!address) throw new Error(t(lang, "err.resolveFailed"));

  return new Promise((resolve, reject) => {
    // Pin the validated address so DNS cannot change between validation and connection.
    const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(url, {
      lookup: (_hostname, options, callback) => {
        if (options.all) callback(null, [address]);
        else callback(null, address.address, address.family);
      },
      agent: false, signal,
      headers: { "User-Agent": "Reedar/0.1 (+local RSS reader)", Accept: "text/html, application/xhtml+xml, application/rss+xml, application/atom+xml, application/xml, text/xml, image/*;q=0.8, */*;q=0.1", "Accept-Encoding": "identity", ...requestHeaders },
    }, (response) => {
      if (response.statusCode && [301, 302, 303, 307, 308].includes(response.statusCode)) {
        response.resume();
        if (redirects >= 4 || !response.headers.location) return reject(new Error(t(lang, "err.redirect")));
        const next = new URL(response.headers.location, url).href;
        fetchPublic(next, redirects + 1, signal, lang, requestHeaders).then(resolve, reject);
        return;
      }
      if (response.statusCode === 304) {
        response.resume();
        resolve({ body: Buffer.alloc(0), url: url.href, contentType: "", notModified: true });
        return;
      }
      if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
        response.resume();
        reject(new Error(t(lang, "err.httpStatus", { status: response.statusCode ?? "error" })));
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      response.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_BYTES) request.destroy(new Error(t(lang, "err.tooLarge")));
        else chunks.push(chunk);
      });
      response.on("error", reject);
      response.on("end", () => resolve({ body: Buffer.concat(chunks), url: url.href, contentType: response.headers["content-type"] ?? "", etag: response.headers.etag, lastModified: response.headers["last-modified"] }));
    });
    const timeout = setTimeout(() => request.destroy(new Error(t(lang, "err.timeout"))), 20_000);
    request.on("close", () => clearTimeout(timeout));
    request.on("error", reject);
    request.end();
  });
}
