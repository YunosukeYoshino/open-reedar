import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { z } from "zod";
import type { Action, Agent, CliInstall, Connection, Conversation, OpmlImport, OpmlPreview, OrganizeJob, Snapshot, Update } from "../shared/schema";
import { agentSchema, codexModel } from "../shared/schema";
import { agentError, AuthenticationRequired, connection, LocalizedError, runOrganizer, runReader } from "./agents/reader";
import { loadArticleText } from "./article-text";
import { loadFeed } from "./feeds";
import { parseOpml } from "./opml";
import { publicUrl } from "./network";
import { Store } from "./store";
import { installCli } from "./cli-install";
import { defaultLanguage, t } from "../shared/i18n";
import type { MessageKey } from "../shared/i18n";

type Dependencies = { fetchArticleText: typeof loadArticleText; fetchFeed: typeof loadFeed; run: typeof runReader; connect: typeof connection; organize: typeof runOrganizer };
const defaults: Dependencies = { fetchArticleText: loadArticleText, fetchFeed: loadFeed, run: runReader, connect: connection, organize: runOrganizer };

const organizeResponseSchema = z.object({
  moves: z.array(z.object({ feedId: z.string(), folder: z.string() })).max(500).optional(),
  assignments: z.array(z.object({ url: z.string(), folder: z.string() })).max(500).optional(),
});

export class Engine {
  connections: Connection[] = agentSchema.options.map((agent) => ({ agent, installed: false, status: "checking", detail: t(defaultLanguage, "conn.checking") }));
  refreshing = false;
  opmlImport: OpmlImport | null = null;
  opmlPreview: OpmlPreview | null = null;
  organize: OrganizeJob | null = null;
  cliInstall: CliInstall | null = null;
  private importJob: { controller: AbortController; done: Promise<void> } | undefined;
  private organizeRun: { controller: AbortController; done: Promise<void> } | undefined;
  private autoRefreshTimer: ReturnType<typeof setInterval> | undefined;
  private refreshJob: Promise<void> | undefined;
  private markReadUndoIds: string[] = [];
  private listeners = new Set<(update: Update) => void>();
  private jobs = new Map<string, { controller: AbortController; done: Promise<void> }>();

  private readonly dependencies: Dependencies;

  constructor(readonly store: Store, private readonly runnerDirectory: string, dependencies: Partial<Dependencies> = {}) {
    this.dependencies = { ...defaults, ...dependencies };
  }

  async initialize() {
    await mkdir(this.runnerDirectory, { recursive: true, mode: 0o700 });
    this.scheduleAutoRefresh();
    await this.refreshConnections();
  }

  private scheduleAutoRefresh() {
    if (this.autoRefreshTimer) clearInterval(this.autoRefreshTimer);
    this.autoRefreshTimer = undefined;
    const minutes = this.store.state.refreshMinutes;
    if (minutes > 0) {
      this.autoRefreshTimer = setInterval(() => { this.queueAutoRefresh(); }, minutes * 60_000);
      this.autoRefreshTimer.unref();
    }
  }

  private queueAutoRefresh() {
    if (this.refreshJob) return;
    this.refreshJob = this.refreshFeeds(true)
      .catch((error: unknown) => { console.error("reedar: automatic refresh failed", error); })
      .finally(() => { this.refreshJob = undefined; });
  }

  get snapshot(): Snapshot { return { state: this.store.state, connections: this.connections, refreshing: this.refreshing, opmlImport: this.opmlImport, opmlPreview: this.opmlPreview, organize: this.organize, cliInstall: this.cliInstall, markReadUndo: this.markReadUndoIds.length ? { count: this.markReadUndoIds.length } : null }; }

  subscribe(listener: (update: Update) => void) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  private emit(update: Update) { for (const listener of this.listeners) listener(update); }
  private changed() { this.emit({ type: "snapshot", snapshot: this.snapshot }); }

  private t(key: MessageKey, params?: Record<string, string | number>) { return t(this.store.state.language, key, params); }

  private async installCli() {
    this.cliInstall = await installCli();
    this.changed();
  }

  private connectionProbe = 0;

  async refreshConnections() {
    const generation = ++this.connectionProbe;
    const connections = await Promise.all(agentSchema.options.map((agent) => this.dependencies.connect(agent, this.runnerDirectory, this.store.state.language)));
    if (generation !== this.connectionProbe) return;
    this.connections = connections;
    this.changed();
  }

  async dispatch(action: Action) {
    switch (action.type) {
      case "feed.add": {
        const url = publicUrl(action.url, this.store.state.language).href;
        const existing = this.store.state.feeds.find((feed) => feed.url === url);
        if (existing?.removedAt) {
          existing.folderId = this.store.folder(action.folderId);
          delete existing.removedAt;
          break;
        }
        if (existing) throw new Error(this.t("err.feedExists"));
        const result = await this.dependencies.fetchFeed(url, this.store.folder(action.folderId), undefined, this.store.state.language);
        this.store.mergeFeed({ ...result.feed, etag: result.etag, lastModified: result.lastModified }, result.articles);
        break;
      }
      case "feed.remove":
      case "feed.restore": {
        const feed = this.store.state.feeds.find((item) => item.id === action.id);
        if (!feed) throw new Error(this.t("err.feedMissing"));
        if (action.type === "feed.restore") delete feed.removedAt;
        else {
          feed.removedAt = new Date().toISOString();
          const ids = new Set<string>();
          for (const article of this.store.state.articles) if (article.feedId === feed.id) ids.add(article.id);
          const stops: Promise<void>[] = [];
          for (const conversation of this.store.state.conversations) {
            if (ids.has(conversation.articleId) && this.jobs.has(conversation.id)) stops.push(this.stop(conversation.id));
          }
          await Promise.all(stops);
        }
        break;
      }
      case "feed.move": {
        const feed = this.store.state.feeds.find((item) => item.id === action.id);
        if (!feed) throw new Error(this.t("err.feedMissing"));
        feed.folderId = this.store.folder(action.folderId);
        break;
      }
      case "folder.save": this.store.saveFolder(action.id, action.name); break;
      case "folder.remove": this.store.removeFolder(action.id); break;
      case "article.read": {
        this.store.article(action.id).read = action.read;
        // An explicit per-article change supersedes the bulk operation so undo does not overwrite it.
        this.markReadUndoIds = this.markReadUndoIds.filter((id) => id !== action.id);
        break;
      }
      case "articles.markRead": {
        const ids = action.scope.type === "feed" ? new Set([action.scope.id]) : new Set(this.store.state.feeds.filter((feed) => !feed.removedAt && feed.folderId === action.scope.id).map((feed) => feed.id));
        this.markReadUndoIds = [];
        for (const article of this.store.state.articles) if (ids.has(article.feedId) && !this.store.state.feeds.find((feed) => feed.id === article.feedId)?.removedAt && !article.read) { article.read = true; this.markReadUndoIds.push(article.id); }
        break;
      }
      case "articles.markReadUndo": {
        const ids = new Set(this.markReadUndoIds);
        for (const article of this.store.state.articles) if (ids.has(article.id)) article.read = false;
        this.markReadUndoIds = [];
        break;
      }
      case "article.fetchText": return this.fetchArticleText(action.id);
      case "article.star": this.store.article(action.id).starred = action.starred; break;
      case "app.setLanguage": this.store.state.language = action.language; void this.refreshConnections(); break;
      case "app.setRefreshInterval": this.store.state.refreshMinutes = action.minutes; this.scheduleAutoRefresh(); break;
      case "opml.import": return this.importOpml(action.xml, action.urls, action.folders);
      case "opml.preview": return this.previewOpml(action.xml);
      case "opml.previewClear": this.opmlPreview = null; this.changed(); return;
      case "opml.stop": this.importJob?.controller.abort(); return;
      case "organize.propose": return this.proposeOrganize(action.agent, action.scope);
      case "organize.apply": this.applyOrganize(action.moves, action.assignments); break;
      case "organize.cancel": this.organizeRun?.controller.abort(); this.organize = null; this.changed(); return;
      case "organize.clear": {
        if (this.organizeRun) throw new Error(this.t("err.organizeRunning"));
        this.organize = null;
        this.changed();
        return;
      }
      case "refresh": {
        this.refreshJob ??= this.refreshFeeds(action.automatic === true).finally(() => { this.refreshJob = undefined; });
        return this.refreshJob;
      }
      case "connections.refresh": return this.refreshConnections();
      case "cli.install": return this.installCli();
      case "chat.send": return this.send(action.articleId, action.agent, action.text);
      case "chat.summarize": return this.send(action.articleId, action.agent, this.t("prompt.summarize"), "summary");
      case "chat.stop": return this.stop(action.conversationId);
    }
    await this.store.save();
    this.changed();
  }

  private async fetchArticleText(id: string) {
    const url = this.store.article(id).url;
    const result = await this.dependencies.fetchArticleText(url, new AbortController().signal, this.store.state.language);
    const article = this.store.state.articles.find((item) => item.id === id);
    if (!article || article.url !== url) return;
    article.readerHtml = result.html;
    article.readerText = result.text;
    await this.store.save();
    this.changed();
  }

  private async previewOpml(xml: string) {
    let parsed;
    try { parsed = await parseOpml(xml, this.store.state.language); }
    catch (error) { this.opmlPreview = null; this.changed(); throw error; }
    const seen = new Set<string>();
    const opmlUrls = new Set<string>();
    const folders = this.store.state.folders;
    const entries: OpmlPreview["entries"] = [];
    for (const entry of parsed) {
      const base = { url: entry.url, title: entry.title, folderName: entry.folderName };
      let url: string | undefined;
      try { url = publicUrl(entry.url).href; }
      catch { entries.push({ ...base, resolution: "invalid", detail: this.t("err.invalidFeedUrl") }); continue; }
      if (seen.has(url)) { entries.push({ ...base, resolution: "inFileDuplicate", detail: this.t("err.opmlDuplicate") }); continue; }
      seen.add(url);
      opmlUrls.add(url);
      const existing = this.store.state.feeds.find((feed) => feed.url === url);
      if (existing && !existing.removedAt) { entries.push({ ...base, resolution: "duplicate", detail: this.t("err.registered") }); continue; }
      if (existing) { entries.push({ ...base, resolution: "restorable", detail: this.t("err.restorable") }); continue; }
      if (entry.folderName && entry.folderName.length > 60) { entries.push({ ...base, resolution: "invalid", detail: this.t("err.folderNameLong") }); continue; }
      entries.push({ ...base, resolution: "new", detail: entry.folderName && !folders.some((folder) => folder.name === entry.folderName) ? this.t("err.folderCreate", { name: entry.folderName }) : undefined });
    }
    const missingFeeds = this.store.state.feeds
      .filter((feed) => !feed.removedAt && !opmlUrls.has(feed.url))
      .map((feed) => ({ id: feed.id, title: feed.title, url: feed.url, folderName: folders.find((folder) => folder.id === feed.folderId)?.name ?? null }));
    this.opmlPreview = { entries, missingFeeds };
    this.changed();
  }

  private async importOpml(xml: string, urls?: string[], folders?: Record<string, string>) {
    if (this.importJob) throw new Error(this.t("err.importRunning"));
    const selected = urls ? new Set(urls) : null;
    const entries = (await parseOpml(xml, this.store.state.language)).map((entry) => ({ ...entry, folderName: folders?.[entry.url] ?? entry.folderName }))
      .filter((entry) => !selected || selected.has(entry.url));
    if (this.importJob) throw new Error(this.t("err.importRunning"));
    const report: OpmlImport = { status: "running", total: entries.length, results: [] };
    this.opmlImport = report;
    this.changed();
    const controller = new AbortController();
    const seen = new Set<string>();
    const done = (async () => {
      await Promise.resolve();
      try {
        for (let offset = 0; offset < entries.length && !controller.signal.aborted; offset += 4) {
          await Promise.all(entries.slice(offset, offset + 4).map(async (entry) => {
            const item = { id: randomUUID(), title: entry.title, url: entry.url };
            try {
              let url: string;
              try { url = publicUrl(entry.url).href; }
              catch { report.results.push({ ...item, status: "failed", detail: this.t("err.invalidFeedUrl") }); return; }
              if (seen.has(url)) { report.results.push({ ...item, status: "skipped", detail: this.t("err.opmlDuplicate") }); return; }
              seen.add(url);
              const existing = this.store.state.feeds.find((feed) => feed.url === url);
              if (existing && !existing.removedAt) { report.results.push({ ...item, status: "skipped", detail: this.t("err.registered") }); return; }
              if (entry.folderName && entry.folderName.length > 60) { report.results.push({ ...item, status: "failed", detail: this.t("err.folderNameLong") }); return; }
              const removedAt = existing?.removedAt;
              const result = existing ? { feed: existing, articles: [] } : await this.dependencies.fetchFeed(url, null, controller.signal, this.store.state.language);
              if (controller.signal.aborted) return;
              const current = this.store.state.feeds.find((feed) => feed.url === url);
              if (current && (!current.removedAt || current.removedAt !== removedAt)) {
                report.results.push({ ...item, status: "skipped", detail: this.t("err.changedWhileImporting") }); return;
              }
              let folderId: string | null = null;
              if (entry.folderName) {
                let folder = this.store.state.folders.find((folder) => folder.name === entry.folderName);
                if (!folder) { this.store.saveFolder(null, entry.folderName); folder = this.store.state.folders.find((folder) => folder.name === entry.folderName); }
                folderId = folder?.id ?? null;
              }
              this.store.mergeFeed({ ...result.feed, title: entry.title || result.feed.title, folderId, removedAt: undefined, etag: result.etag ?? result.feed.etag, lastModified: result.lastModified ?? result.feed.lastModified }, result.articles);
              await this.store.save();
              report.results.push({ ...item, status: "imported", detail: existing ? this.t("err.restored") : this.t("err.imported") });
            } catch {
              if (!controller.signal.aborted) report.results.push({ ...item, status: "failed", detail: this.t("err.fetchSaveFailed") });
            } finally { this.changed(); }
          }));
        }
        report.status = controller.signal.aborted ? "cancelled" : "completed";
      } catch {
        report.status = "failed";
        report.error = this.t("err.importFailed");
      } finally { this.importJob = undefined; this.opmlPreview = null; this.changed(); }
    })();
    this.importJob = { controller, done };
    void done.catch(() => {});
  }

  private proposeOrganize(agent: Agent, scope: OrganizeJob["scope"]) {
    if (this.organizeRun) throw new Error(this.t("err.organizeRunning"));
    if (scope === "opml" && !this.opmlPreview?.entries.some((entry) => entry.resolution === "new" || entry.resolution === "restorable")) {
      throw new Error(this.t("err.organizeNeedPreview"));
    }
    const startedAt = new Date().toISOString();
    const prompt = this.organizePrompt(scope);
    const controller = new AbortController();
    this.organize = { scope, agent, status: "running", startedAt };
    this.changed();
    const done = (async () => {
      let text = "";
      try {
        await this.dependencies.organize(agent, prompt, this.runnerDirectory, controller.signal, (event) => {
          if (!controller.signal.aborted && event.type === "delta") text = event.text;
        }, this.store.state.language);
        if (controller.signal.aborted) return;
        this.organize = { scope, agent, status: "completed", startedAt, plan: this.organizePlan(scope, text) };
      } catch (error) {
        this.organize = controller.signal.aborted ? null
          : { scope, agent, status: "failed", startedAt, detail: agentError(error, this.store.state.language) };
      } finally { this.organizeRun = undefined; this.changed(); }
    })();
    this.organizeRun = { controller, done };
    void done.catch(() => { this.changed(); });
  }

  private organizePrompt(scope: OrganizeJob["scope"]) {
    const folders = this.store.state.folders.map((folder) => folder.name);
    if (scope === "opml") {
      const entries = (this.opmlPreview?.entries ?? [])
        .filter((entry) => entry.resolution === "new" || entry.resolution === "restorable")
        .map((entry) => ({ url: entry.url, title: entry.title, folder: entry.folderName }));
      return JSON.stringify({ task: this.t("prompt.organizeOpml"), folders, entries });
    }
    const feeds = this.store.state.feeds.filter((feed) => !feed.removedAt).map((feed) => ({
      id: feed.id, title: feed.title, url: feed.url,
      folder: this.store.state.folders.find((folder) => folder.id === feed.folderId)?.name ?? null,
      recent: this.store.state.articles.filter((article) => article.feedId === feed.id).slice(0, 3).map((article) => article.title),
    }));
    return JSON.stringify({ task: this.t("prompt.organizeLibrary"), folders, feeds });
  }

  private organizePlan(scope: OrganizeJob["scope"], text: string): NonNullable<OrganizeJob["plan"]> {
    let parsed: z.infer<typeof organizeResponseSchema>;
    try {
      const start = text.indexOf("{");
      const end = text.lastIndexOf("}");
      parsed = organizeResponseSchema.parse(JSON.parse(start >= 0 && end > start ? text.slice(start, end + 1) : text));
    } catch { throw new LocalizedError(this.t("err.organizeParse")); }
    const folders = this.store.state.folders;
    const plan: NonNullable<OrganizeJob["plan"]> = { moves: [], assignments: [] };
    if (scope === "opml") {
      const seen = new Set<string>();
      for (const item of parsed.assignments ?? []) {
        const folderName = item.folder.trim();
        const entry = this.opmlPreview?.entries.find((e) => e.url === item.url && (e.resolution === "new" || e.resolution === "restorable"));
        if (!entry || !folderName || folderName.length > 60 || entry.folderName === folderName || seen.has(item.url)) continue;
        seen.add(item.url);
        plan.assignments.push({ url: entry.url, title: entry.title, folderName });
      }
      return plan;
    }
    const seen = new Set<string>();
    for (const item of parsed.moves ?? []) {
      const folderName = item.folder.trim();
      const feed = this.store.state.feeds.find((f) => f.id === item.feedId && !f.removedAt);
      const current = feed ? folders.find((f) => f.id === feed.folderId)?.name ?? null : null;
      if (!feed || !folderName || folderName.length > 60 || current === folderName || seen.has(item.feedId)) continue;
      seen.add(item.feedId);
      plan.moves.push({ feedId: feed.id, title: feed.title, folderName, newFolder: !folders.some((f) => f.name === folderName) });
    }
    return plan;
  }

  private applyOrganize(moves?: { feedId: string; folderName: string }[], assignments?: { url: string; folderName: string }[]) {
    const job = this.organize;
    if (!job || job.status !== "completed" || !job.plan) throw new Error(this.t("err.organizeNothing"));
    if (job.scope === "opml") {
      const preview = this.opmlPreview;
      if (!preview) throw new Error(this.t("err.noPreview"));
      const folders = this.store.state.folders;
      for (const item of assignments ?? []) {
        const folderName = item.folderName.trim();
        const entry = preview.entries.find((e) => e.url === item.url && (e.resolution === "new" || e.resolution === "restorable"));
        if (!entry || !folderName || folderName.length > 60) continue;
        entry.folderName = folderName;
        entry.detail = folders.some((f) => f.name === folderName) ? undefined : this.t("err.folderCreate", { name: folderName });
      }
      this.organize = null;
      return;
    }
    for (const item of moves ?? []) {
      const feed = this.store.state.feeds.find((f) => f.id === item.feedId && !f.removedAt);
      const folderName = item.folderName.trim();
      if (!feed || !folderName || folderName.length > 60) continue;
      let folder = this.store.state.folders.find((f) => f.name === folderName);
      if (!folder) { this.store.saveFolder(null, folderName); folder = this.store.state.folders.find((f) => f.name === folderName); }
      if (folder) feed.folderId = folder.id;
    }
    this.organize = null;
  }

  private async refreshFeeds(automatic: boolean) {
    if (this.refreshing) return;
    this.refreshing = true;
    this.changed();
    const now = new Date().toISOString();
    try {
      const feeds = this.store.state.feeds.filter((feed) => !feed.removedAt && (!automatic || !feed.backoffUntil || feed.backoffUntil <= now));
      for (let offset = 0; offset < feeds.length; offset += 4) {
        await Promise.all(feeds.slice(offset, offset + 4).map(async (feed) => {
          const current = () => this.store.state.feeds.find((item) => item.id === feed.id);
          try {
            const result = await this.dependencies.fetchFeed(feed.url, feed.folderId, undefined, this.store.state.language, { etag: feed.etag, lastModified: feed.lastModified });
            const merged = current();
            if (!merged || merged.removedAt) return;
            if (result.notModified) {
              merged.updatedAt = new Date().toISOString();
              merged.error = null;
              merged.failures = 0;
              merged.etag = result.etag ?? merged.etag;
              merged.lastModified = result.lastModified ?? merged.lastModified;
              delete merged.backoffUntil;
              return;
            }
            this.store.mergeFeed({ ...result.feed, folderId: merged.folderId, etag: result.etag, lastModified: result.lastModified }, result.articles);
          } catch (error) {
            const merged = current();
            if (merged) {
              merged.error = error instanceof Error ? error.message : this.t("err.updateFailed");
              merged.failures = (merged.failures ?? 0) + 1;
              merged.backoffUntil = new Date(Date.now() + Math.min(merged.failures * merged.failures, 24) * 5 * 60_000).toISOString();
            }
          }
        }));
        await this.store.save();
      }
    } finally { this.refreshing = false; this.changed(); }
  }

  private async send(articleId: string, agent: Conversation["agent"], text: string, purpose: "chat" | "summary" = "chat") {
    const article = this.store.article(articleId);
    if (this.store.state.feeds.find((feed) => feed.id === article.feedId)?.removedAt) throw new Error(this.t("err.removedFeed"));
    let conversation = this.store.state.conversations.find((item) => item.articleId === articleId && item.agent === agent);
    if (!conversation) {
      conversation = {
        id: randomUUID(), articleId, agent,
        source: { title: article.title, url: article.url, text: article.text, capturedAt: new Date().toISOString() }, messages: [],
      };
      this.store.state.conversations.push(conversation);
    }
    if (this.jobs.has(conversation.id)) throw new Error(this.t("err.conversationRunning"));
    if (this.jobs.size >= 2) throw new Error(this.t("err.tooManyConversations"));
    const history = structuredClone(conversation.messages);
    const now = new Date().toISOString();
    const message: Extract<Conversation["messages"][number], { role: "assistant" }> = {
      id: randomUUID(), role: "assistant", text: "", createdAt: now, state: { status: "running", phase: conversation.source.origin === "web" ? "answering" : "fetching" }, purpose,
      ...(agent === "codex" ? { model: codexModel } : {}),
    };
    conversation.messages.push({ id: randomUUID(), role: "user", text, createdAt: now }, message);
    const current = conversation;
    const controller = new AbortController();
    let notifyTimer: ReturnType<typeof setTimeout> | undefined;
    const notify = () => {
      if (!notifyTimer) notifyTimer = setTimeout(() => { notifyTimer = undefined; this.emit({ type: "conversation", conversation: current }); }, 60);
    };
    const done = (async () => {
      try {
        await this.store.save();
        this.changed();
        if (current.source.origin !== "web") {
          try {
            const source = await this.dependencies.fetchArticleText(article.url, controller.signal, this.store.state.language);
            controller.signal.throwIfAborted();
            if (source.text.trim().length < current.source.text.trim().length) throw new Error("Extracted body is shorter than the feed");
            if (history.length && !current.previousSource) current.previousSource = structuredClone(current.source);
            current.source = { title: article.title, url: source.url, text: source.text, capturedAt: new Date().toISOString(), origin: "web" };
          } catch {
            controller.signal.throwIfAborted();
            current.source = { ...current.source, origin: "feed", fetchError: this.t("err.feedTextOnly") };
          }
        }
        controller.signal.throwIfAborted();
        if (!current.source.text.trim()) {
          message.state = { status: "failed", error: this.t("err.fetchArticleFailed") };
          return;
        }
        message.sourceOrigin = current.source.origin;
        message.state = { status: "running", phase: "answering" };
        await this.store.save();
        this.changed();
        const previous = { ...structuredClone(current), messages: history };
        await this.dependencies.run(agent, previous, text, this.runnerDirectory, controller.signal, (event) => {
          if (controller.signal.aborted) return;
          if (event.type === "delta") { message.text = event.text; message.state = { status: "running" }; }
          else message.state = { status: "waiting", reason: event.reason };
          notify();
        }, this.store.state.language);
        if (!controller.signal.aborted) message.state = { status: "completed" };
      } catch (error) {
        message.state = controller.signal.aborted ? { status: "cancelled" }
          : error instanceof AuthenticationRequired ? { status: "waiting", reason: error.message }
          : { status: "failed", error: agentError(error, this.store.state.language) };
      } finally {
        if (notifyTimer) clearTimeout(notifyTimer);
        try { await this.store.save(); }
        finally { this.jobs.delete(current.id); this.changed(); }
      }
    })();
    this.jobs.set(current.id, { controller, done });
    // The job owns its errors and persists an explicit final state; the HTTP request only starts it.
    void done.catch(() => { this.changed(); });
  }

  private async stop(conversationId: string) {
    this.jobs.get(conversationId)?.controller.abort();
    const conversation = this.store.state.conversations.find((item) => item.id === conversationId);
    const last = conversation?.messages.at(-1);
    if (last?.role === "assistant" && ["running", "waiting"].includes(last.state.status)) last.state = { status: "cancelled" };
    await this.store.save();
    this.changed();
  }

  async settle() { await Promise.all([...this.jobs.values()].map((job) => job.done).concat(this.importJob ? [this.importJob.done] : []).concat(this.organizeRun ? [this.organizeRun.done] : [])); }

  async close() {
    if (this.autoRefreshTimer) clearInterval(this.autoRefreshTimer);
    this.autoRefreshTimer = undefined;
    await this.refreshJob?.catch(() => {});
    this.importJob?.controller.abort();
    this.organizeRun?.controller.abort();
    for (const job of this.jobs.values()) job.controller.abort();
    await this.settle();
    await this.store.save();
  }
}
