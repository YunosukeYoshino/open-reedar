import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { stateSchema, storedStateSchema } from "../shared/schema";
import type { Article, ArticleRecovery, Feed, Language, ReaderState } from "../shared/schema";
import { t } from "../shared/i18n";
import { ARTICLES_DB_FILENAME, ArticlesDb, mergeArticle } from "./articles-db";
import type { SearchMatch } from "./articles-db";

export class Store {
  state: ReaderState;
  /** Set whenever a save actually wrote article rows; lets the engine re-run an open search only after real changes. */
  articlesChanged = false;
  private writing: Promise<void> = Promise.resolve();
  private db: ArticlesDb | null;
  private revisions = new Map<string, string>();
  private restoredFromBackup = new Map<string, string>();
  private recoveryRemoved = new Set<string>();

  private constructor(private readonly path: string, state: ReaderState, db: ArticlesDb | null) {
    this.state = state;
    this.db = db;
  }

  static async open(path: string, options: { dbPath?: string } = {}) {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    let state: ReaderState;
    let recovery: ArticleRecovery | undefined;
    try {
      const stored = storedStateSchema.parse(JSON.parse(await readFile(path, "utf8")));
      recovery = stored.articleRecovery;
      state = stateSchema.parse(stored);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
        throw new Error(t("en", "err.storeUnreadable"), { cause: error });
      }
      state = { version: 1, folders: [], feeds: [], articles: [], conversations: [], language: "en", refreshMinutes: 30, fontSize: "m", articlesRetentionDays: 0 };
    }
    let db: ArticlesDb | null = null;
    try {
      db = ArticlesDb.open(options.dbPath ?? join(dirname(path), ARTICLES_DB_FILENAME));
    } catch (error) {
      console.error("reedar: article database unavailable, running without search", error);
    }
    const store = new Store(path, state, db);
    store.recoveryRemoved = new Set(recovery?.removed);
    if (!db) {
      const articles = new Map<string, Article>();
      try {
        const backup = stateSchema.parse(JSON.parse(await readFile(`${path}.bak`, "utf8")));
        for (const article of backup.articles) store.restoredFromBackup.set(article.id, JSON.stringify(article));
        for (const article of backup.articles) articles.set(article.id, article);
      } catch { /* keep any available JSON copy */ }
      for (const article of [...recovery?.updated ?? [], ...state.articles]) articles.set(article.id, article);
      for (const id of store.recoveryRemoved) articles.delete(id);
      state.articles = [...articles.values()];
    }
    if (db) {
      if (recovery) db.write(recovery.updated.filter((article) => db.get(article.id)), recovery.removed);
      if (state.articles.length) {
        db.merge(state.articles);
        try { await copyFile(path, `${path}.bak`, constants.COPYFILE_EXCL); }
        catch (error) { if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error; }
        await chmod(`${path}.bak`, 0o600);
        const migrated = `${path}.migrated`;
        await writeFile(migrated, JSON.stringify(stateSchema.parse({ ...state, articles: [] })), { mode: 0o600 });
        await rename(migrated, path);
      }
      state.articles = db.all();
      for (const article of state.articles) store.revisions.set(article.id, JSON.stringify(article));
    }
    for (const conversation of state.conversations) {
      for (const message of conversation.messages) {
        if (message.role === "assistant" && ["running", "waiting"].includes(message.state.status)) {
          message.state = { status: "failed", error: t(state.language, "err.interrupted") };
          if (message.text.trim()) message.partial = true;
        }
      }
    }
    await store.save();
    return store;
  }

  get searchAvailable() { return this.db !== null; }

  searchArticles(query: string): SearchMatch[] | null {
    return this.db?.search(query) ?? null;
  }

  close() { this.db?.close(); }

  save() {
    if (this.db) this.syncArticles();
    const articles = this.db ? [] : this.state.articles.filter((article) => !this.restoredFromBackup.has(article.id));
    const ids = new Set(this.state.articles.map((article) => article.id));
    const articleRecovery = this.db || (!this.restoredFromBackup.size && !this.recoveryRemoved.size) ? undefined : {
      updated: this.state.articles.filter((article) => this.restoredFromBackup.has(article.id) && this.restoredFromBackup.get(article.id) !== JSON.stringify(article)),
      removed: [...new Set([...this.recoveryRemoved, ...this.restoredFromBackup.keys()])].filter((id) => !ids.has(id)),
    };
    const data = JSON.stringify(storedStateSchema.parse({ ...this.state, articles, articleRecovery }));
    const write = this.writing.catch(() => {}).then(async () => {
      const temporary = `${this.path}.pending`;
      await writeFile(temporary, data, { mode: 0o600 });
      await rename(temporary, this.path);
    });
    this.writing = write;
    return write;
  }

  private syncArticles() {
    const changed = new Map<string, { article: Article; serialized: string }>();
    const seen = new Set<string>();
    for (const article of this.state.articles) {
      seen.add(article.id);
      const serialized = JSON.stringify(article);
      if (this.revisions.get(article.id) !== serialized) changed.set(article.id, { article, serialized });
    }
    const removed = [...this.revisions.keys()].filter((id) => !seen.has(id));
    if (!changed.size && !removed.length) return;
    this.db!.write([...changed.values()].map((entry) => entry.article), removed);
    this.articlesChanged = true;
    for (const [id, { serialized }] of changed) this.revisions.set(id, serialized);
    for (const id of removed) this.revisions.delete(id);
  }

  article(id: string, lang: Language = this.state.language) {
    const article = this.state.articles.find((item) => item.id === id);
    if (!article) throw new Error(t(lang, "err.articleMissing"));
    return article;
  }

  folder(id: string | null, lang: Language = this.state.language) {
    if (id !== null && !this.state.folders.some((folder) => folder.id === id)) {
      throw new Error(t(lang, "err.folderMissing"));
    }
    return id;
  }

  saveFolder(id: string | null, name: string, lang: Language = this.state.language) {
    if (this.state.folders.some((folder) => folder.name === name && folder.id !== id)) {
      throw new Error(t(lang, "err.folderDuplicate"));
    }
    if (id === null) this.state.folders.push({ id: randomUUID(), name });
    else {
      const folder = this.state.folders.find((item) => item.id === id);
      if (!folder) throw new Error(t(lang, "err.folderMissing"));
      folder.name = name;
    }
  }

  removeFolder(id: string, lang: Language = this.state.language) {
    if (!this.state.folders.some((folder) => folder.id === id)) throw new Error(t(lang, "err.folderMissing"));
    for (const feed of this.state.feeds) {
      if (feed.folderId === id) feed.folderId = null;
    }
    this.state.folders = this.state.folders.filter((folder) => folder.id !== id);
  }

  mergeFeed(feed: Feed, articles: Article[]) {
    const index = this.state.feeds.findIndex((item) => item.id === feed.id);
    if (index === -1) this.state.feeds.push(feed);
    else this.state.feeds[index] = feed;
    const existing = new Map(this.state.articles.map((article) => [article.id, article]));
    for (const article of articles) {
      existing.set(article.id, mergeArticle(article, existing.get(article.id)));
    }
    this.state.articles = [...existing.values()].sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
  }
}
