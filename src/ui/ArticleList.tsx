import { Search, Rss, Star, X } from "lucide-react";
import type { Article, Feed } from "../shared/schema";
import { useFormatters, useT } from "./i18n";
import type { Filter } from "./Sidebar";

type Props = { title: string; articles: Article[]; feeds: Feed[]; selectedId: string | null; filter: Filter; setFilter: (filter: Filter) => void; search: string; setSearch: (value: string) => void; onSelect: (article: Article) => void };

export function ArticleList({ title, articles, feeds, selectedId, filter, setFilter, search, setSearch, onSelect }: Props) {
  const t = useT();
  const fmt = useFormatters();
  const feedNames = new Map(feeds.map((feed) => [feed.id, feed.title]));
  return <section className="article-list" aria-label={t("list.articles")}>
    <header className="list-heading"><div><h1>{title}</h1><p>{t("list.count", { count: articles.length })}</p></div><Rss size={17} className="muted" /></header>
    <div className="list-filter"><div className="segmented" role="group" aria-label={t("list.filter")}>{(["all", "unread", "starred"] as const).map((value) => <button key={value} aria-pressed={filter === value} className={filter === value ? "active" : ""} onClick={() => setFilter(value)}>{value === "all" ? t("list.all") : value === "unread" ? t("sidebar.unread") : t("sidebar.starred")}</button>)}</div></div>
    <div className="search-field"><Search size={14} /><input id="article-search" aria-label={t("list.search")} placeholder={t("list.search")} value={search} onChange={(event) => setSearch(event.target.value)} />{search ? <button className="icon-button" aria-label={t("list.clearSearch")} onClick={() => setSearch("")}><X size={13} /></button> : <kbd aria-hidden="true">/</kbd>}</div>
    <div className="article-items">
      {articles.map((article) => <button key={article.id} className={`article-row ${selectedId === article.id ? "selected" : ""} ${article.read ? "is-read" : ""}`} onClick={() => onSelect(article)} aria-current={selectedId === article.id ? "true" : undefined} aria-label={t(article.read ? "list.articleRead" : "list.articleUnread", { title: article.title })}>
        <div className="article-row-meta"><span>{feedNames.get(article.feedId)}</span><time dateTime={article.publishedAt}>{fmt.shortDate.format(new Date(article.publishedAt))}</time></div>
        <div className="article-row-content"><div className="article-row-copy"><h2>{!article.read ? <span className="unread-dot" /> : null}{article.title}</h2><p>{article.excerpt || t("list.excerptFallback")}</p></div>{article.imageUrl ? <img className="article-thumbnail" src={`/image?url=${encodeURIComponent(article.imageUrl)}`} alt="" loading="lazy" onError={(event) => { event.currentTarget.hidden = true; }} /> : null}</div>
        <div className="article-row-footer"><span>{fmt.time.format(new Date(article.publishedAt))}</span>{article.starred ? <Star size={11} className="star-filled" /> : null}</div>
      </button>)}
      {!articles.length ? <div className="list-empty"><Rss size={26} strokeWidth={1.4} /><h2>{search ? t("list.emptySearch") : filter === "starred" ? t("list.emptyStarred") : filter === "unread" ? t("list.emptyUnread") : t("list.emptyAll")}</h2><p>{search ? t("list.emptySearchHint") : feeds.length ? t("list.emptyHintFiltered") : t("list.emptyHint")}</p></div> : null}
    </div>
    <footer className="list-footer"><span>{t("list.unreadCount", { count: articles.filter((article) => !article.read).length })}</span><span><kbd>J</kbd><kbd>K</kbd> {t("list.navigateKeys")}</span></footer>
  </section>;
}
