import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { stateSchema } from "../shared/schema";
import type { Article, Feed, ReaderState } from "../shared/schema";

export class Store {
  state: ReaderState;
  private writing: Promise<void> = Promise.resolve();

  private constructor(private readonly path: string, state: ReaderState) {
    this.state = state;
  }

  static async open(path: string) {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    let state: ReaderState;
    try {
      state = stateSchema.parse(JSON.parse(await readFile(path, "utf8")));
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
        throw new Error("保存データを読み込めませんでした。元のファイルは保持されています。", { cause: error });
      }
      state = { version: 1, folders: [], feeds: [], articles: [], conversations: [] };
    }
    for (const conversation of state.conversations) {
      for (const message of conversation.messages) {
        if (message.role === "assistant" && ["running", "waiting"].includes(message.state.status)) {
          message.state = { status: "failed", error: "前回の実行中にアプリが終了しました。もう一度質問を送信できます。" };
        }
      }
    }
    const store = new Store(path, state);
    await store.save();
    return store;
  }

  save() {
    const data = JSON.stringify(stateSchema.parse(this.state));
    const write = this.writing.catch(() => {}).then(async () => {
      const temporary = `${this.path}.pending`;
      await writeFile(temporary, data, { mode: 0o600 });
      await rename(temporary, this.path);
    });
    this.writing = write;
    return write;
  }

  article(id: string) {
    const article = this.state.articles.find((item) => item.id === id);
    if (!article) throw new Error("記事が見つかりません。");
    return article;
  }

  folder(id: string | null) {
    if (id !== null && !this.state.folders.some((folder) => folder.id === id)) {
      throw new Error("フォルダが見つかりません。");
    }
    return id;
  }

  saveFolder(id: string | null, name: string) {
    if (this.state.folders.some((folder) => folder.name === name && folder.id !== id)) {
      throw new Error("同じ名前のフォルダがあります。");
    }
    if (id === null) this.state.folders.push({ id: randomUUID(), name });
    else {
      const folder = this.state.folders.find((item) => item.id === id);
      if (!folder) throw new Error("フォルダが見つかりません。");
      folder.name = name;
    }
  }

  removeFolder(id: string) {
    if (!this.state.folders.some((folder) => folder.id === id)) throw new Error("フォルダが見つかりません。");
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
      const old = existing.get(article.id);
      existing.set(article.id, old ? { ...article, read: old.read, starred: old.starred, receivedAt: old.receivedAt } : article);
    }
    this.state.articles = [...existing.values()].sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
  }
}
