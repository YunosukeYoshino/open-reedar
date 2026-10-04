import { DatabaseSync } from "node:sqlite";
import type { Article } from "../shared/schema";

export const ARTICLES_DB_FILENAME = "articles.db";
const SEARCH_LIMIT = 200;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS articles (
  id TEXT PRIMARY KEY,
  feed_id TEXT NOT NULL,
  title TEXT NOT NULL,
  url TEXT NOT NULL,
  author TEXT NOT NULL,
  published_at TEXT NOT NULL,
  received_at TEXT NOT NULL,
  html TEXT NOT NULL,
  text TEXT NOT NULL,
  excerpt TEXT NOT NULL,
  image_url TEXT,
  read INTEGER NOT NULL,
  starred INTEGER NOT NULL,
  reader_html TEXT,
  reader_text TEXT,
  note TEXT,
  highlights TEXT
);
CREATE VIRTUAL TABLE IF NOT EXISTS articles_fts USING fts5(title, text, reader_text, content='articles', content_rowid='rowid');
CREATE TRIGGER IF NOT EXISTS articles_ai AFTER INSERT ON articles BEGIN
  INSERT INTO articles_fts(rowid, title, text, reader_text) VALUES (new.rowid, new.title, new.text, new.reader_text);
END;
CREATE TRIGGER IF NOT EXISTS articles_ad AFTER DELETE ON articles BEGIN
  INSERT INTO articles_fts(articles_fts, rowid, title, text, reader_text) VALUES('delete', old.rowid, old.title, old.text, old.reader_text);
END;
CREATE TRIGGER IF NOT EXISTS articles_au AFTER UPDATE ON articles BEGIN
  INSERT INTO articles_fts(articles_fts, rowid, title, text, reader_text) VALUES('delete', old.rowid, old.title, old.text, old.reader_text);
  INSERT INTO articles_fts(rowid, title, text, reader_text) VALUES (new.rowid, new.title, new.text, new.reader_text);
END;
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  article_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`;

type Row = {
  id: string; feed_id: string; title: string; url: string; author: string;
  published_at: string; received_at: string; html: string; text: string; excerpt: string;
  image_url: string | null; read: number; starred: number;
  reader_html: string | null; reader_text: string | null; note: string | null; highlights: string | null;
};

function toArticle(row: Row): Article {
  return {
    id: row.id, feedId: row.feed_id, title: row.title, url: row.url, author: row.author,
    publishedAt: row.published_at, receivedAt: row.received_at, html: row.html, text: row.text,
    excerpt: row.excerpt, imageUrl: row.image_url, read: row.read === 1, starred: row.starred === 1,
    ...(row.reader_html === null ? {} : { readerHtml: row.reader_html }),
    ...(row.reader_text === null ? {} : { readerText: row.reader_text }),
    ...(row.note === null ? {} : { note: row.note }),
    ...(row.highlights === null ? {} : { highlights: JSON.parse(row.highlights) as string[] }),
  };
}

/** Annotations and reader state always survive a refresh merge: the fresh copy wins on content, the stored copy wins on read/starred/received/note/highlights. */
export function mergeArticle(fresh: Article, stored?: Article): Article {
  if (!stored) return fresh;
  return {
    ...fresh,
    read: stored.read, starred: stored.starred, receivedAt: stored.receivedAt,
    note: stored.note ?? fresh.note, highlights: stored.highlights ?? fresh.highlights,
    ...(stored.url === fresh.url ? { readerHtml: stored.readerHtml ?? fresh.readerHtml, readerText: stored.readerText ?? fresh.readerText } : {}),
  };
}

export type SearchMatch = { id: string; feedId: string };

export class ArticlesDb {
  private constructor(private readonly db: DatabaseSync) {}

  static open(path: string) {
    let db: DatabaseSync | undefined;
    try {
      db = new DatabaseSync(path);
      db.exec("PRAGMA journal_mode = WAL");
      db.exec("PRAGMA busy_timeout = 2000");
      // INSERT OR REPLACE's implicit delete only fires DELETE triggers under recursive_triggers; without it FTS entries orphan.
      db.exec("PRAGMA recursive_triggers = ON");
      const version = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
      if (version > 1) throw new Error(`articles.db is a newer version (${version})`);
      db.exec(SCHEMA);
      db.exec("PRAGMA user_version = 1");
      const check = db.prepare("PRAGMA quick_check").get() as { quick_check: string };
      if (check.quick_check !== "ok") throw new Error(`articles.db failed integrity check: ${check.quick_check}`);
      const articles = new ArticlesDb(db);
      articles.all();
      return articles;
    } catch (error) {
      db?.close();
      throw error;
    }
  }

  close() { this.db.close(); }

  all(): Article[] {
    return (this.db.prepare("SELECT * FROM articles ORDER BY published_at DESC").all() as Row[]).map(toArticle);
  }

  get(id: string): Article | undefined {
    const row = this.db.prepare("SELECT * FROM articles WHERE id = ?").get(id) as Row | undefined;
    return row ? toArticle(row) : undefined;
  }

  /** Upserts fresh articles while preserving stored annotations and reader state, in one transaction. */
  merge(articles: readonly Article[]) {
    this.write(articles.map((fresh) => mergeArticle(fresh, this.get(fresh.id))), []);
  }

  /** Upserts articles verbatim and removes ids absent from the caller's copy, in one transaction. */
  write(articles: readonly Article[], removeIds: readonly string[] = []) {
    const insert = this.db.prepare("INSERT OR REPLACE INTO articles (id, feed_id, title, url, author, published_at, received_at, html, text, excerpt, image_url, read, starred, reader_html, reader_text, note, highlights) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
    const remove = this.db.prepare("DELETE FROM articles WHERE id IN (SELECT value FROM json_each(?))");
    this.db.exec("BEGIN");
    try {
      for (const article of articles) {
        insert.run(
          article.id, article.feedId, article.title, article.url, article.author, article.publishedAt, article.receivedAt,
          article.html, article.text, article.excerpt, article.imageUrl, article.read ? 1 : 0, article.starred ? 1 : 0,
          article.readerHtml ?? null, article.readerText ?? null, article.note ?? null,
          article.highlights === undefined ? null : JSON.stringify(article.highlights),
        );
      }
      if (removeIds.length) remove.run(JSON.stringify(removeIds));
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  search(query: string): SearchMatch[] {
    const match = query.trim().split(/\s+/).filter(Boolean).map((term) => `"${term.replaceAll('"', '""')}"`).join(" ");
    if (!match) return [];
    const rows = this.db.prepare("SELECT a.id AS id, a.feed_id AS feedId FROM articles_fts f JOIN articles a ON a.rowid = f.rowid WHERE articles_fts MATCH ? ORDER BY rank LIMIT ?").all(match, SEARCH_LIMIT) as SearchMatch[];
    return rows;
  }
}
