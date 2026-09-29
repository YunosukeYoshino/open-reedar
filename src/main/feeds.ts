import { createHash } from "node:crypto";
import { decode } from "html-entities";
import Parser from "rss-parser";
import sanitizeHtml from "sanitize-html";
import { z } from "zod";
import type { Article, Feed, Language } from "../shared/schema";
import { fetchPublic, publicUrl } from "./network";
import { t } from "../shared/i18n";

const optionalText = z.string().optional().catch(undefined);
const parsedFeedSchema = z.object({
  title: optionalText, link: optionalText,
  items: z.array(z.object({
    title: optionalText, link: optionalText, guid: optionalText, id: optionalText, creator: optionalText, author: optionalText,
    isoDate: optionalText, pubDate: optionalText, content: optionalText, "content:encoded": optionalText,
    summary: optionalText, enclosure: z.object({ url: optionalText, type: optionalText }).optional().catch(undefined),
  })).max(2000),
});
const parser = new Parser();
const hash = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 24);

export function safeLink(value: string | undefined, base: string): string {
  if (!value) return "";
  try { return publicUrl(new URL(value, base).href).href; }
  catch { return ""; }
}

export function plainText(html: string) {
  return decode(sanitizeHtml(html.replace(/<\/(p|div|li|h[1-6]|blockquote)>|<br\s*\/?\s*>/gi, "\n"), { allowedTags: [], allowedAttributes: {} }))
    .replace(/[\t ]+/g, " ").replace(/\n\s*\n\s*\n/g, "\n\n").trim();
}

export function cleanArticle(html: string, base: string) {
  let imageUrl: string | null = null;
  const clean = sanitizeHtml(html, {
    allowedTags: ["p", "div", "span", "br", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "ul", "ol", "li", "strong", "b", "em", "i", "s", "del", "a", "code", "pre", "hr", "figure", "figcaption", "img", "table", "thead", "tbody", "tr", "th", "td", "sup", "sub"],
    allowedAttributes: { a: ["href", "target", "rel"], img: ["src", "alt", "loading", "decoding"], ol: ["start"] },
    allowedSchemes: ["https", "http"],
    allowProtocolRelative: false,
    transformTags: {
      a: (_name, attributes) => ({ tagName: "a", attribs: { href: safeLink(attributes.href, base), target: "_blank", rel: "noopener noreferrer" } }),
      img: (_name, attributes) => {
        const src = safeLink(attributes.src, base);
        if (src && imageUrl === null) imageUrl = src;
        const attribs: Record<string, string> = {};
        if (src) Object.assign(attribs, { src: `/image?url=${encodeURIComponent(src)}`, alt: attributes.alt ?? "", loading: "lazy", decoding: "async" });
        return { tagName: "img", attribs };
      },
    },
    exclusiveFilter: (frame) => frame.tag === "img" && !frame.attribs.src,
  });
  return { html: clean, text: plainText(clean), imageUrl };
}

export class FeedUserError extends Error {}

export async function parseFeed(xml: string, url: string, folderId: string | null, now = new Date().toISOString(), lang: Language = "en") {
  if (/^\s*(<!doctype\s+html|<html[\s>])/i.test(xml)) throw new FeedUserError(t(lang, "err.notAFeed"));
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new FeedUserError(t(lang, "err.entityXml"));
  const parsed = parsedFeedSchema.parse(await parser.parseString(xml));
  const feedId = hash(url);
  const feed: Feed = { id: feedId, url, title: plainText(parsed.title ?? "") || new URL(url).hostname, siteUrl: safeLink(parsed.link, url) || url, folderId, updatedAt: now, error: null };
  const articles: Article[] = parsed.items.map((item) => {
    const link = safeLink(item.link, url);
    const title = plainText(item.title ?? "") || t(lang, "err.noTitle");
    const body = cleanArticle(item["content:encoded"] || item.content || item.summary || "", link || url);
    const published = new Date(item.isoDate || item.pubDate || now);
    const identity = item.guid || item.id || link || `${title}:${item.isoDate || item.pubDate || ""}`;
    return {
      id: hash(`${feedId}:${identity}`), feedId, title, url: link || feed.siteUrl,
      author: plainText(item.creator || item.author || ""),
      publishedAt: Number.isNaN(published.getTime()) ? now : published.toISOString(), receivedAt: now,
      ...body, excerpt: body.text.replace(/\s+/g, " ").slice(0, 180), read: false, starred: false,
      imageUrl: body.imageUrl || (item.enclosure?.type?.startsWith("image/") ? safeLink(item.enclosure.url, url) || null : null),
    };
  });
  return { feed, articles };
}

export function decodeBody(body: Buffer, contentType: string) {
  const label = /charset=["']?([^;\s"']+)/i.exec(contentType)?.[1]
    ?? /<\?xml[^?]*encoding=["']?([^\s"'?>]+)/i.exec(body.subarray(0, 512).toString("latin1"))?.[1]
    ?? "utf-8";
  try { return new TextDecoder(label).decode(body); }
  catch { return body.toString("utf8"); }
}

export async function loadFeed(url: string, folderId: string | null, signal?: AbortSignal, lang: Language = "en") {
  const result = await fetchPublic(url, 0, signal, lang);
  const xml = decodeBody(result.body, result.contentType);
  try { return await parseFeed(xml, url, folderId, undefined, lang); }
  catch (error) {
    if (error instanceof FeedUserError) throw error;
    throw new FeedUserError(t(lang, "err.notAFeed"), { cause: error });
  }
}
