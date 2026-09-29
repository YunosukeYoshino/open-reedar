import { Readability } from "@mozilla/readability";
import { DOMParser } from "linkedom";
import { plainText } from "./feeds";
import { fetchPublic } from "./network";
import { t } from "../shared/i18n";
import type { Language } from "../shared/schema";

export function extractArticleText(html: string, url: string, lang: Language = "en") {
  // This DOM parser does not run scripts or load page resources.
  const document = new DOMParser().parseFromString(html, "text/html");
  Object.defineProperty(document, "documentURI", { value: url });
  Object.defineProperty(document, "baseURI", { value: url });
  // Linkedom implements the DOM operations Readability uses, but omits unrelated browser APIs.
  // Keep this library type mismatch at the adapter boundary; extraction fixtures cover compatibility.
  const article = new Readability(document as unknown as Document, { charThreshold: 200, maxElemsToParse: 20_000 }).parse();
  const text = plainText(article?.content ?? "");
  if (text.length < 200) throw new Error(t(lang, "err.articleExtract"));
  return text;
}

export async function loadArticleText(url: string, signal: AbortSignal, lang: Language = "en") {
  const result = await fetchPublic(url, 0, AbortSignal.any([signal, AbortSignal.timeout(25_000)]), lang);
  signal.throwIfAborted();
  if (!/^(text\/html|application\/xhtml\+xml)(?:;|$)/i.test(result.contentType)) throw new Error(t(lang, "err.notHtml"));
  const charset = /charset=["']?([^;\s"']+)/i.exec(result.contentType)?.[1]
    ?? /<meta[^>]+charset=["']?([^\s"'/>]+)/i.exec(result.body.subarray(0, 4096).toString("ascii"))?.[1] ?? "utf-8";
  return { text: extractArticleText(new TextDecoder(charset).decode(result.body), result.url, lang), url: result.url };
}
