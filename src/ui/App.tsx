import { useDeferredValue, useEffect, useRef, useState } from "react";
import { AlertCircle, X } from "lucide-react";
import type { Agent, Article, Conversation, ReaderState } from "../shared/schema";
import { Sidebar } from "./Sidebar";
import type { Filter, Scope } from "./Sidebar";
import { ArticleList } from "./ArticleList";
import { Reader } from "./Reader";
import { PluginPanel } from "./PluginPanel";
import { AiPanel } from "./AiPanel";
import { LibraryDialogs } from "./LibraryDialogs";
import { useReader } from "./use-reader";
import { t } from "../shared/i18n";
import { LangProvider } from "./i18n";

function activeLibrary(state: ReaderState): ReaderState {
  const feeds = state.feeds.filter((feed) => !feed.removedAt);
  const feedIds = new Set(feeds.map((feed) => feed.id));
  const articles = state.articles.filter((article) => feedIds.has(article.feedId));
  const articleIds = new Set(articles.map((article) => article.id));
  return { ...state, feeds, articles, conversations: state.conversations.filter((conversation) => articleIds.has(conversation.articleId)) };
}

export function App() {
  const { snapshot, connected, error, setError, act, perform } = useReader();
  const [scope, setScope] = useState<Scope>({ type: "all" });
  const [filter, setFilter] = useState<Filter>("all");
  const [search, setSearch] = useState("");
  const query = useDeferredValue(search.trim().toLocaleLowerCase());
  const [globalSearch, setGlobalSearch] = useState("");
  const lastSearch = useRef("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [aiOpen, setAiOpen] = useState(false);
  const [folderId, setFolderId] = useState<string | null>(null);
  const [openPlugin, setOpenPlugin] = useState<string | null>(null);
  const state = snapshot ? activeLibrary(snapshot.state) : undefined;
  const article = state?.articles.find((item) => item.id === selectedId);
  const feed = state?.feeds.find((item) => item.id === article?.feedId);
  const feedIds = new Set(state?.feeds.filter((item) => scope.type === "feed" ? item.id === scope.id : scope.type === "folder" ? item.folderId === scope.id : true).map((item) => item.id));
  const byId = new Map((state?.articles ?? []).map((item) => [item.id, item]));
  const base = scope.type === "search"
    ? (snapshot?.search?.results ?? []).map((match) => byId.get(match.id)).filter((item): item is Article => item !== undefined)
    : (state?.articles ?? []).filter((item) => feedIds.has(item.feedId)).sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
  const articles = base.filter((item) => (filter === "all" || (filter === "unread" ? !item.read || item.id === selectedId : item.starred)) && (!query || `${item.title} ${item.text}`.toLocaleLowerCase().includes(query)));
  const index = articles.findIndex((item) => item.id === selectedId);
  const lang = snapshot?.state.language ?? "en";
  const title = scope.type === "search" ? t(lang, "search.title", { query: snapshot?.search?.query ?? globalSearch.trim() }) : scope.type === "all" ? t(lang, "app.allArticles") : scope.type === "feed" ? state?.feeds.find((item) => item.id === scope.id)?.title ?? t(lang, "app.feed") : state?.folders.find((item) => item.id === scope.id)?.name ?? t(lang, "app.folder");
  const panelPlugin = openPlugin ? (snapshot?.plugins ?? []).find((item) => item.name === openPlugin && item.status === "ready" && item.manifest?.type === "panel" && item.manifest.placement === "sidebar") : undefined;
  const [pinnedAgent, setPinnedAgent] = useState<Agent | null>(null);
  const agent = pinnedAgent ?? snapshot?.state.defaultAgent ?? "codex";
  const setAgent = (value: Agent) => { setPinnedAgent(null); perform({ type: "app.setDefaultAgent", agent: value }); };
  const conversation = state?.conversations.find((item) => item.articleId === selectedId && item.agent === agent);
  function selectArticle(item: Article) { setSelectedId(item.id); setPinnedAgent(null); if (!item.read) perform({ type: "article.read", id: item.id, read: true }); }
  function move(offset: number) { const item = articles[index + offset]; if (item) selectArticle(item); }
  function openConversation(item: Conversation) { setScope({ type: "all" }); setFilter("all"); setSearch(""); setGlobalSearch(""); setSelectedId(item.articleId); setPinnedAgent(item.agent); setAiOpen(true); }
  useEffect(() => {
    const value = globalSearch.trim();
    if (value === lastSearch.current) return;
    const timer = setTimeout(() => {
      lastSearch.current = value;
      if (value) { setScope({ type: "search" }); perform({ type: "articles.search", query: value }); }
      else { perform({ type: "articles.searchClear" }); setScope((current) => current.type === "search" ? { type: "all" } : current); }
    }, 250);
    return () => clearTimeout(timer);
  }, [globalSearch, perform]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey || event.isComposing || document.querySelector("dialog[open]") || event.target instanceof HTMLElement && (event.target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(event.target.tagName))) return;
      if (event.key === "j" || event.key === "ArrowDown") { event.preventDefault(); move(1); }
      else if (event.key === "k" || event.key === "ArrowUp") { event.preventDefault(); move(-1); }
      else if (event.key === "/") { event.preventDefault(); document.querySelector<HTMLInputElement>("#article-search")?.focus(); }
      else if (event.key === "n") document.querySelector<HTMLDialogElement>("#feed-dialog")?.showModal();
      else if (event.key === "s" && article) perform({ type: "article.star", id: article.id, starred: !article.starred });
      else if (event.key === "m" && article) perform({ type: "article.read", id: article.id, read: !article.read });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
  useEffect(() => { document.documentElement.lang = lang; }, [lang]);
  if (!snapshot || !state) return <div className="loading-screen"><span className="loading-dot" /><p>{connected ? t("en", "app.loadingLibrary") : t("en", "app.connecting")}</p>{error ? <p role="alert">{error}</p> : null}</div>;
  return <LangProvider value={lang}><main className={`app-shell ${navigator.userAgent.includes("Electron") ? "desktop" : ""} ${aiOpen && article ? "ai-is-open" : ""}`}><Sidebar state={state} scope={scope} filter={filter} refreshing={snapshot.refreshing} markReadUndo={snapshot.markReadUndo ?? null} select={(value, nextFilter) => { setScope(value); setFilter(nextFilter ?? "all"); setSearch(""); setGlobalSearch(""); setSelectedId(null); setOpenPlugin(null); }} perform={perform} editFolder={setFolderId} searchAvailable={snapshot.searchAvailable ?? false} globalSearch={globalSearch} setGlobalSearch={setGlobalSearch} plugins={snapshot.plugins ?? []} openPlugin={openPlugin} openPluginPanel={setOpenPlugin} act={act} /><ArticleList title={title} articles={articles} feeds={state.feeds} selectedId={selectedId} filter={filter} setFilter={(value) => { setFilter(value); setSelectedId(null); }} search={search} setSearch={setSearch} onSelect={selectArticle} searchUnavailable={scope.type === "search" && snapshot.search?.unavailable === true} />{panelPlugin ? <section className="reader plugin-pane" aria-label={panelPlugin.manifest?.title ?? panelPlugin.name}><PluginPanel key={panelPlugin.name} plugin={panelPlugin} article={article} feeds={state.feeds} folders={state.folders} act={act} /></section> : <Reader agent={agent} conversation={conversation} act={act} article={article} feed={feed} aiOpen={aiOpen} toggleAi={() => setAiOpen(!aiOpen)} perform={perform} fontSize={state.fontSize} plugins={snapshot.plugins ?? []} feeds={state.feeds} folders={state.folders} previous={() => move(-1)} next={() => move(1)} hasPrevious={index > 0} hasNext={index < articles.length - 1} nextTitle={articles[index + 1]?.title} />}{aiOpen && article ? <AiPanel key={`${article.id}:${agent}`} article={article} agent={agent} setAgent={setAgent} conversation={conversation} connections={snapshot.connections} appleModel={state.appleModel} act={act} perform={perform} close={() => setAiOpen(false)} /> : null}</main><LibraryDialogs snapshot={{ ...snapshot, state }} articles={articles} removedFeeds={snapshot.state.feeds.filter((feed) => feed.removedAt)} folderId={folderId} act={act} perform={perform} openConversation={openConversation} />{error || !connected ? <div className="toast" role="alert"><AlertCircle size={16} /><span>{error ?? t(lang, "net.disconnected")}</span>{error ? <button className="icon-button" aria-label={t(lang, "net.dismiss")} onClick={() => setError(null)}><X size={14} /></button> : null}</div> : null}</LangProvider>;
}
