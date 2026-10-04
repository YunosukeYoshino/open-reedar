import { ArrowDownUp, BookOpen, Bot, CheckCheck, ChevronDown, ChevronRight, Circle, Folder, FolderPlus, MoreHorizontal, Plus, RefreshCw, Rss, Search, Star, Undo2, X } from "lucide-react";
import { useState } from "react";
import type { Action, ReaderState } from "../shared/schema";
import { tone } from "./format";
import { useT } from "./i18n";

export type Scope = { type: "all" } | { type: "feed" | "folder"; id: string } | { type: "search" };
export type Filter = "all" | "unread" | "starred";
type Props = {
  state: ReaderState; scope: Scope; filter: Filter; refreshing: boolean; markReadUndo: { count: number } | null;
  select: (scope: Scope, filter?: Filter) => void; perform: (action: Action) => void;
  editFolder: (id: string | null) => void;
  searchAvailable: boolean; globalSearch: string; setGlobalSearch: (value: string) => void;
};

export function Sidebar({ state, scope, filter, refreshing, markReadUndo, select, perform, editFolder, searchAvailable, globalSearch, setGlobalSearch }: Props) {
  const t = useT();
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const unread = state.articles.filter((article) => !article.read).length;
  const starred = state.articles.filter((article) => article.starred).length;
  const activeRuns = state.conversations.filter((conversation) => {
    const last = conversation.messages.at(-1);
    return last?.role === "assistant" && ["running", "waiting"].includes(last.state.status);
  }).length;
  const feedRow = (feed: ReaderState["feeds"][number]) => {
    const count = state.articles.filter((article) => article.feedId === feed.id && !article.read).length;
    return <div className={`feed-row-wrap ${scope.type === "feed" && scope.id === feed.id ? "selected" : ""}`} key={feed.id}>
      <button className="nav-row feed-row" onClick={() => select({ type: "feed", id: feed.id })} title={feed.error ?? feed.title} aria-label={feed.error ? `${feed.title}: ${t("sidebar.updateError")}: ${feed.error}` : undefined}>
        <span className="feed-monogram" data-tone={tone(feed.title)}>{feed.title.slice(0, 1)}</span><span className="nav-label">{feed.title}</span>
        {feed.error ? <span className="feed-error-dot" aria-label={t("sidebar.updateError")} /> : count > 0 ? <span className="nav-count">{count}</span> : null}
      </button>
      {count > 0 ? <button className="icon-button mark-read" aria-label={t("sidebar.markRead")} title={t("sidebar.markRead")} onClick={() => perform({ type: "articles.markRead", scope: { type: "feed", id: feed.id } })}><CheckCheck size={13} /></button> : null}
    </div>;
  };
  return <aside className="sidebar" aria-label={t("sidebar.library")}>
    <div className="sidebar-header"><button className="brand" onClick={() => select({ type: "all" }, "all")}><Rss size={21} strokeWidth={2.4} /><span>Reedar</span></button>
      <div className="sidebar-tools"><button className="icon-button" aria-label={t("sidebar.refreshFeeds")} title={t("sidebar.refreshFeeds")} disabled={refreshing || state.feeds.length === 0} onClick={() => perform({ type: "refresh" })}><RefreshCw size={14} className={refreshing ? "spin" : ""} /></button><select className="refresh-interval" aria-label={t("sidebar.autoRefresh")} title={t("sidebar.autoRefresh")} value={state.refreshMinutes} onChange={(event) => perform({ type: "app.setRefreshInterval", minutes: Number(event.target.value) })}>{[0, 15, 30, 60, 120, 360].map((minutes) => <option key={minutes} value={minutes}>{minutes === 0 ? t("sidebar.refreshOff") : minutes < 60 ? t("sidebar.refreshMin", { minutes }) : t("sidebar.refreshHour", { hours: minutes / 60 })}</option>)}</select><button className="icon-button" commandfor="feed-dialog" command="show-modal" aria-label={t("sidebar.addFeed")} title={`${t("sidebar.addFeed")} (N)`}><Plus size={18} /></button></div>
    </div>
    <div className="sidebar-scroll">
      <div className="search-field sidebar-search" title={searchAvailable ? undefined : t("search.unavailable")}>
        <Search size={13} />
        <input aria-label={t("search.placeholder")} placeholder={t("search.placeholder")} value={globalSearch} disabled={!searchAvailable} onChange={(event) => setGlobalSearch(event.target.value)} />
        {globalSearch ? <button className="icon-button" aria-label={t("list.clearSearch")} onClick={() => setGlobalSearch("")}><X size={13} /></button> : null}
      </div>
      <nav className="primary-nav" aria-label={t("sidebar.navKind")}>
        <button className={`nav-row ${scope.type === "all" && filter === "all" ? "selected" : ""}`} onClick={() => select({ type: "all" }, "all")}><BookOpen size={17} /><span className="nav-label">{t("app.allArticles")}</span><span className="nav-count">{state.articles.length || ""}</span></button>
        <button className={`nav-row ${scope.type === "all" && filter === "unread" ? "selected" : ""}`} onClick={() => select({ type: "all" }, "unread")}><Circle size={16} /><span className="nav-label">{t("sidebar.unread")}</span><span className="nav-count">{unread || ""}</span></button>
        <button className={`nav-row ${scope.type === "all" && filter === "starred" ? "selected" : ""}`} onClick={() => select({ type: "all" }, "starred")}><Star size={17} /><span className="nav-label">{t("sidebar.starred")}</span><span className="nav-count">{starred || ""}</span></button>
      </nav>
      <div className="section-heading"><span>{t("sidebar.feeds")}</span><div className="toolbar-group"><button className="icon-button" commandfor="organize-dialog" command="show-modal" aria-label={t("sidebar.organizeFeeds")} title={t("sidebar.organizeFeeds")}><MoreHorizontal size={15} /></button><button className="icon-button" commandfor="folder-dialog" command="show-modal" onClick={() => editFolder(null)} aria-label={t("sidebar.newFolder")} title={t("sidebar.newFolder")}><FolderPlus size={15} /></button></div></div>
      {state.folders.map((folder) => {
        const feeds = state.feeds.filter((feed) => feed.folderId === folder.id);
        const ids = new Set(feeds.map((feed) => feed.id));
        const count = state.articles.filter((article) => ids.has(article.feedId) && !article.read).length;
        const folded = collapsed.has(folder.id);
        return <section className="folder-group" key={folder.id} aria-label={folder.name}>
          <div className={`folder-row ${scope.type === "folder" && scope.id === folder.id ? "selected" : ""}`}>
            <button className="folder-toggle icon-button" aria-label={t("sidebar.collapseFolder", { action: folded ? t("sidebar.expand") : t("sidebar.collapse"), name: folder.name })} aria-expanded={!folded} onClick={() => setCollapsed((previous) => { const next = new Set(previous); if (next.has(folder.id)) next.delete(folder.id); else next.add(folder.id); return next; })}>{folded ? <ChevronRight size={13} /> : <ChevronDown size={13} />}</button>
            <button className="folder-select" onClick={() => select({ type: "folder", id: folder.id })}><Folder size={15} /><span className="nav-label">{folder.name}</span><span className="nav-count">{count || ""}</span></button>
            {count > 0 ? <button className="icon-button mark-read" aria-label={t("sidebar.markRead")} title={t("sidebar.markRead")} onClick={() => perform({ type: "articles.markRead", scope: { type: "folder", id: folder.id } })}><CheckCheck size={13} /></button> : null}
            <button className="icon-button folder-edit" commandfor="folder-dialog" command="show-modal" onClick={() => editFolder(folder.id)} aria-label={t("sidebar.editFolder", { name: folder.name })}><MoreHorizontal size={14} /></button>
          </div>
          {!folded ? <div className="folder-feeds">{feeds.length ? feeds.map(feedRow) : <p className="empty-folder">{t("sidebar.folderAddFeeds")}</p>}</div> : null}
        </section>;
      })}
      <div className="unfiled-feeds">{state.feeds.filter((feed) => feed.folderId === null).map(feedRow)}</div>
      {!state.feeds.length ? <button className="add-first-feed" commandfor="feed-dialog" command="show-modal"><Plus size={15} />{t("sidebar.addFirstFeed")}</button> : null}
    </div>
    {markReadUndo ? <div className="undo-banner" role="status"><span>{t("sidebar.markedRead", { count: markReadUndo.count })}</span><button onClick={() => perform({ type: "articles.markReadUndo" })}><Undo2 size={12} />{t("sidebar.undo")}</button></div> : null}
    <div className="sidebar-bottom">
      <button className="nav-row" commandfor="opml-dialog" command="show-modal"><ArrowDownUp size={16} /><span className="nav-label">{t("sidebar.opml")}</span></button>
      <button className="nav-row" commandfor="activity-dialog" command="show-modal"><Bot size={17} /><span className="nav-label">{t("sidebar.conversations")}</span>{activeRuns ? <span className="activity-count">{activeRuns}</span> : <span className="nav-count">{state.conversations.length || ""}</span>}</button>
      <button className="connection-link" commandfor="connections-dialog" command="show-modal"><span className="local-dot" />{t("sidebar.connections")}<span>↗</span></button>
    </div>
  </aside>;
}
