import { useCallback, useEffect, useRef, useState } from "react";
import type { WheelEvent } from "react";
import { ArrowDown, ArrowUp, BookOpen, Bot, Circle, ExternalLink, Loader2, Star, X } from "lucide-react";
import type { Action, Agent, Article, Conversation, Feed, ReaderState } from "../shared/schema";
import { ArticleContent } from "./ArticleContent";
import { domain, readingMinutes } from "./format";
import { useFormatters, useT } from "./i18n";

type Props = { agent: Agent; conversation: Conversation | undefined; act: (action: Action) => Promise<void>; article: Article | undefined; feed: Feed | undefined; aiOpen: boolean; toggleAi: () => void; perform: (action: Action) => void; fontSize: ReaderState["fontSize"]; previous: () => void; next: () => void; hasPrevious: boolean; hasNext: boolean; nextTitle: string | undefined };

function ArticleNotes({ article, perform }: { article: Article; perform: (action: Action) => void }) {
  const t = useT();
  const highlights = article.highlights ?? [];
  return <details className="article-notes"><summary>{t("reader.notes")}</summary>
    <label className="note-label">{t("reader.note")}<textarea defaultValue={article.note ?? ""} placeholder={t("reader.notePlaceholder")} rows={3} maxLength={8000} onBlur={(event) => { if (event.target.value !== (article.note ?? "")) perform({ type: "article.note", id: article.id, note: event.target.value }); }} /></label>
    {highlights.length ? <ul className="highlights">{highlights.map((text, index) => <li key={`${index}:${text.length}`}><blockquote>{text}</blockquote><button className="icon-button" aria-label={t("reader.highlightRemove")} onClick={() => perform({ type: "article.highlights", id: article.id, highlights: highlights.filter((_, i) => i !== index) })}><X size={12} /></button></li>)}</ul> : null}
    <button className="text-button" onClick={() => { const text = window.getSelection()?.toString().trim(); if (text) perform({ type: "article.highlights", id: article.id, highlights: [...highlights, text.slice(0, 2000)] }); }}>{t("reader.highlightAdd")}</button>
  </details>;
}

export function Reader({ agent, conversation, act, article, feed, aiOpen, toggleAi, perform, fontSize, previous, next, hasPrevious, hasNext, nextTitle }: Props) {
  const t = useT();
  const fmt = useFormatters();
  const [webView, setWebView] = useState(false);
  const [fetching, setFetching] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [atEnd, setAtEnd] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const overscroll = useRef(0);
  const shownAt = useRef(0);
  useEffect(() => {
    setWebView(!!article?.readerHtml); setFetching(false); setFetchError(null); overscroll.current = 0; shownAt.current = Date.now();
  }, [article?.id]);
  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (el) {
      const cueHeight = el.querySelector(".next-cue")?.getBoundingClientRect().height ?? 0;
      setAtEnd(el.scrollTop + el.clientHeight >= el.scrollHeight - cueHeight - 24);
    }
  }, []);
  useEffect(() => {
    onScroll();
  }, [article?.id, webView, onScroll]);
  function onWheel(event: WheelEvent<HTMLDivElement>) {
    const el = scrollRef.current;
    const bottom = el ? el.scrollTop + el.clientHeight >= el.scrollHeight - 4 : false;
    if (event.deltaY > 0 && bottom && hasNext && Date.now() - shownAt.current > 500) {
      overscroll.current += event.deltaY;
      if (overscroll.current > 240) { overscroll.current = 0; next(); }
    } else overscroll.current = 0;
  }
  async function loadReaderView() {
    if (!article || fetching) return;
    setFetching(true); setFetchError(null);
    try { await act({ type: "article.fetchText", id: article.id }); setWebView(true); }
    catch (error: unknown) { setFetchError(error instanceof Error ? error.message : t("net.performFailed")); }
    finally { setFetching(false); }
  }
  return <section className={`reader ${aiOpen ? "with-ai" : ""}`} aria-label={t("reader.body")}>
    <header className="reader-toolbar"><div className="toolbar-group"><button className="icon-button" aria-label={t("reader.previous")} onClick={previous} disabled={!hasPrevious}><ArrowUp size={17} /></button><button className="icon-button" aria-label={t("reader.next")} onClick={next} disabled={!hasNext}><ArrowDown size={17} /></button></div>
      {article ? <div className="toolbar-group"><button className="icon-button" aria-label={article.read ? t("reader.markUnread") : t("reader.markRead")} title={`${article.read ? t("reader.markUnread") : t("reader.markRead")} (M)`} onClick={() => perform({ type: "article.read", id: article.id, read: !article.read })}><Circle size={16} className={!article.read ? "unread-icon" : ""} /></button><button className={`icon-button ${article.starred ? "star-filled" : ""}`} aria-label={article.starred ? t("reader.unstar") : t("reader.star")} aria-pressed={article.starred} title={t("reader.starTitle")} onClick={() => perform({ type: "article.star", id: article.id, starred: !article.starred })}><Star size={17} /></button><a className="icon-button" href={article.url} target="_blank" rel="noopener noreferrer" aria-label={t("reader.openOriginal")} title={t("reader.openOriginalShort")}><ExternalLink size={16} /></a><button className="icon-button" aria-label={article.readerHtml ? (webView ? t("reader.feedView") : t("reader.readerView")) : t("reader.fetchArticle")} title={article.readerHtml ? (webView ? t("reader.feedView") : t("reader.readerView")) : t("reader.fetchArticle")} aria-pressed={article.readerHtml ? webView : undefined} disabled={fetching} onClick={() => { if (article.readerHtml) setWebView(!webView); else void loadReaderView(); }}>{fetching ? <Loader2 size={16} className="spin" /> : <BookOpen size={16} />}</button><select className="font-size" aria-label={t("reader.fontSize")} value={fontSize} onChange={(event) => perform({ type: "app.setFontSize", size: event.target.value as ReaderState["fontSize"] })}><option value="s">S</option><option value="m">M</option><option value="l">L</option></select><span className="toolbar-divider" /><button className={`ai-toggle ${aiOpen ? "active" : ""}`} onClick={toggleAi} aria-pressed={aiOpen}><Bot size={17} /><span>{t("reader.readWithAi")}</span>{aiOpen ? <X size={13} /> : null}</button></div> : null}
    </header>
    {article ? <div className="reader-scroll" key={article.id} ref={scrollRef} onScroll={onScroll} onWheel={onWheel}><article className={`article-body font-${fontSize}`}><div className="article-source"><span>{feed?.title ?? domain(article.url)}</span><span>·</span><time dateTime={article.publishedAt}>{fmt.fullDate.format(new Date(article.publishedAt))}</time></div><h1>{article.title}</h1><div className="article-byline">{article.author ? <span>{article.author}</span> : null}<span>{t("reader.readingMinutes", { minutes: readingMinutes(article) })}</span></div>{fetchError ? <p className="form-error" role="alert">{fetchError}</p> : null}<ArticleContent key={`${article.id}:${agent}`} article={article} agent={agent} conversation={conversation} act={act} perform={perform} webView={webView} /><a className="original-link" href={article.url} target="_blank" rel="noopener noreferrer">{t("reader.originalAt", { domain: domain(article.url) })}<ExternalLink size={13} /></a><ArticleNotes article={article} perform={perform} /></article>{atEnd ? (hasNext ? <button className="next-cue" onClick={next}><span>{t("reader.next")}</span><strong>{nextTitle}</strong><ArrowDown size={15} /></button> : <p className="next-cue caught-up">{t("reader.caughtUp")}</p>) : null}</div> : <div className="reader-empty"><div className="empty-mark"><Bot size={32} strokeWidth={1.3} /></div><h2>{t("reader.emptyTitle")}</h2><p>{t("reader.emptyBody")}</p><button className="text-button" commandfor="feed-dialog" command="show-modal">{t("reader.addFeed")}</button></div>}
  </section>;
}
