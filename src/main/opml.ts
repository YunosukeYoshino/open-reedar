import { parseStringPromise } from "xml2js";
import { z } from "zod";
import type { Feed, Language, ReaderState } from "../shared/schema";
import { plainText } from "./feeds";
import { t } from "../shared/i18n";

const outlineSchema = z.object({ $: z.record(z.string(), z.string()).optional(), outline: z.array(z.unknown()).optional() });
const documentSchema = z.object({ opml: z.object({
  $: z.object({ version: z.enum(["1.0", "1.1", "2.0"]) }),
  body: z.array(z.union([z.literal(""), z.object({ outline: z.array(z.unknown()).optional() })])).length(1),
}) });

type Entry = { title: string; url: string; folderName: string | null };

export async function parseOpml(xml: string, lang: Language = "en"): Promise<Entry[]> {
  if (Buffer.byteLength(xml, "utf8") > 262_144) throw new Error(t(lang, "err.opmlSize"));
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error(t(lang, "err.opmlEntity"));
  let parsed: unknown;
  try { parsed = await parseStringPromise(xml, { strict: true, explicitArray: true }); }
  catch { throw new Error(t(lang, "err.opmlXml")); }
  const document = documentSchema.safeParse(parsed);
  if (!document.success) throw new Error(t(lang, "err.opmlVersion"));
  const body = document.data.opml.body[0];
  const roots = typeof body === "object" ? body.outline ?? [] : [];
  const pending: { value: unknown; folders: string[]; depth: number }[] = roots.toReversed().map((value) => ({ value, folders: [], depth: 0 }));
  const entries: Entry[] = [];
  let nodes = 0;
  while (pending.length) {
    const item = pending.pop();
    if (!item) break;
    if (++nodes > 2000 || item.depth > 16) throw new Error(t(lang, "err.opmlDeep"));
    const node = outlineSchema.safeParse(item.value);
    if (!node.success) throw new Error(t(lang, "err.opmlOutline"));
    const attributes = node.data.$ ?? {};
    // External OPML inclusions and ordinary link outlines are never followed.
    if (attributes.isComment === "true" || attributes.type === "link" || attributes.type === "include") continue;
    const title = plainText(attributes.title || attributes.text || "");
    const url = attributes.xmlUrl;
    if (url) {
      entries.push({ title: title || url, url: url.trim(), folderName: item.folders.length ? item.folders.join(" / ") : null });
      if (entries.length > 200) throw new Error(t(lang, "err.opmlMany"));
    }
    const folders = !url && title ? [...item.folders, title] : item.folders;
    for (const value of (node.data.outline ?? []).toReversed()) pending.push({ value, folders, depth: item.depth + 1 });
  }
  return entries;
}

const escapeXml = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");

export function serializeOpml(feeds: Feed[], folders: ReaderState["folders"]) {
  const active = feeds.filter((feed) => !feed.removedAt);
  const outline = (feed: Feed) => `<outline type="rss" text="${escapeXml(feed.title)}" title="${escapeXml(feed.title)}" xmlUrl="${escapeXml(feed.url)}" htmlUrl="${escapeXml(feed.siteUrl)}"/>`;
  const folderIds = new Set(folders.map((folder) => folder.id));
  const groups = folders.map((folder) => `<outline text="${escapeXml(folder.name)}">${active.filter((feed) => feed.folderId === folder.id).map(outline).join("")}</outline>`);
  const unfiled = active.filter((feed) => feed.folderId === null || !folderIds.has(feed.folderId)).map(outline);
  return `<?xml version="1.0" encoding="UTF-8"?>\n<opml version="2.0"><head><title>Reedar subscriptions</title></head><body>${groups.join("")}${unfiled.join("")}</body></opml>\n`;
}
