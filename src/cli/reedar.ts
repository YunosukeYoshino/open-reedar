#!/usr/bin/env bun
import { homedir, tmpdir } from "node:os";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { agentSchema, stateSchema } from "../shared/schema";
import type { Agent, Conversation, ReaderState } from "../shared/schema";
import { agentError, runReader } from "../main/agents/reader";
import type { AgentEvent } from "../main/agents/reader";

const USAGE = `Reedar CLI — read your local Reedar library.

Usage:
  reedar feeds [--json]                 Feed list with unread/star counts (excludes removed feeds)
  reedar articles [--unread] [--starred] [--feed <text>] [--limit N] [--json]
                                        Articles, newest first (default limit 50)
  reedar article <id> [--json]          One article with full text
  reedar summarize <id> [--agent codex|claude] [--question <text>]
                                        Ask an installed agent CLI to summarize/answer about an article

Environment:
  REEDAR_STORE   reader.json path (default: ~/Library/Application Support/Reedar/reader.json)
`;

export function defaultStorePath() {
  return join(homedir(), "Library", "Application Support", "Reedar", "reader.json");
}

export async function loadState(path = process.env.REEDAR_STORE ?? defaultStorePath()): Promise<ReaderState> {
  let raw: string;
  try { raw = await readFile(path, "utf8"); }
  catch { throw new Error(`ライブラリを読み込めませんでした: ${path}`); }
  return stateSchema.parse(JSON.parse(raw));
}

type Out = (text: string) => void;

function flag(args: string[], name: string) { return args.includes(`--${name}`); }
const VALUE_OPTIONS = new Set(["--question", "--agent", "--feed", "--limit"]);
function option(args: string[], name: string) {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
}
function positional(args: string[]) {
  return args.filter((arg, index) => !arg.startsWith("--") && !VALUE_OPTIONS.has(args[index - 1] ?? ""));
}

function feedRows(state: ReaderState) {
  return state.feeds.filter((feed) => !feed.removedAt).map((feed) => {
    const articles = state.articles.filter((article) => article.feedId === feed.id);
    return {
      id: feed.id, title: feed.title, url: feed.url,
      folder: state.folders.find((folder) => folder.id === feed.folderId)?.name ?? null,
      unread: articles.filter((article) => !article.read).length,
      starred: articles.filter((article) => article.starred).length,
      articles: articles.length,
      updatedAt: feed.updatedAt, error: feed.error,
    };
  });
}

function articleRows(state: ReaderState, args: string[]) {
  const feedFilter = option(args, "feed")?.toLowerCase();
  const limit = Number(option(args, "limit") ?? 50);
  const byId = new Map(state.feeds.map((feed) => [feed.id, feed]));
  return state.articles
    .filter((article) => !byId.get(article.feedId)?.removedAt)
    .filter((article) => !flag(args, "unread") || !article.read)
    .filter((article) => !flag(args, "starred") || article.starred)
    .filter((article) => !feedFilter || byId.get(article.feedId)?.title.toLowerCase().includes(feedFilter) || byId.get(article.feedId)?.url.toLowerCase().includes(feedFilter))
    .slice(0, Number.isFinite(limit) ? limit : 50)
    .map((article) => ({
      id: article.id, title: article.title, feed: byId.get(article.feedId)?.title ?? "",
      read: article.read, starred: article.starred, publishedAt: article.publishedAt, url: article.url,
    }));
}

function findArticle(state: ReaderState, id: string) {
  const article = state.articles.find((item) => item.id === id || item.id.startsWith(id));
  if (!article) throw new Error(`記事が見つかりません: ${id}`);
  return article;
}

export async function cli(argv: string[], out: Out, run: typeof runReader = runReader): Promise<number> {
  const [command, ...args] = argv;
  try {
    if (!command || command === "help" || command === "--help" || command === "-h") { out(USAGE.trimEnd()); return 0; }
    const state = await loadState();
    const json = flag(args, "json");
    if (command === "feeds") {
      const rows = feedRows(state);
      if (json) out(JSON.stringify(rows, null, 2));
      else for (const row of rows) out(`${row.unread > 0 ? "●" : "○"} ${row.title} [${row.folder ?? "フォルダなし"}] 未読${row.unread}/${row.articles}${row.error ? ` エラー: ${row.error}` : ""}\n    ${row.url}`);
      return 0;
    }
    if (command === "articles") {
      const rows = articleRows(state, args);
      if (json) out(JSON.stringify(rows, null, 2));
      else for (const row of rows) out(`${row.read ? " " : "●"}${row.starred ? "★" : " "} ${row.publishedAt.slice(0, 10)} ${row.title}  (${row.feed})\n    ${row.id}`);
      return 0;
    }
    const id = positional(args)[0];
    if (command === "article") {
      if (!id) { out("Usage: reedar article <id>"); return 1; }
      const article = findArticle(state, id);
      const feed = state.feeds.find((feed) => feed.id === article.feedId);
      if (json) out(JSON.stringify(article, null, 2));
      else out(`${article.title}\n${feed?.title ?? ""} — ${article.publishedAt.slice(0, 10)} — ${article.url}\n${article.starred ? "★ " : ""}${article.read ? "既読" : "未読"}\n\n${article.text}`);
      return 0;
    }
    if (command === "summarize") {
      if (!id) { out("Usage: reedar summarize <id> [--agent codex|claude] [--question <text>]"); return 1; }
      const agent = (option(args, "agent") ?? "codex") as Agent;
      if (!agentSchema.options.includes(agent)) { out(`不明なエージェントです: ${agent}`); return 1; }
      const article = findArticle(state, id);
      const conversation: Conversation = {
        id: "cli", articleId: article.id, agent,
        source: { title: article.title, url: article.url, text: article.text || article.excerpt, capturedAt: article.receivedAt },
        messages: [],
      };
      let text = "";
      const emit = (event: AgentEvent) => { if (event.type === "delta") text = event.text; };
      const controller = new AbortController();
      process.on("SIGINT", () => controller.abort());
      await run(agent, conversation, option(args, "question") ?? "この記事の要点と結論を日本語で簡潔に要約してください。重要な事実と背景を含め、本文にない推測は避けてください。", tmpdir(), controller.signal, emit);
      if (!text) throw new Error("エージェントから回答を取得できませんでした。");
      out(json ? JSON.stringify({ articleId: article.id, agent, answer: text }) : text);
      return 0;
    }
    out(`不明なコマンドです: ${command}\n\n${USAGE.trimEnd()}`);
    return 1;
  } catch (error) {
    const translated = agentError(error);
    out(`エラー: ${translated.startsWith("エージェントの処理に失敗") && error instanceof Error ? error.message : translated}`);
    return 1;
  }
}

if (import.meta.main) {
  const code = await cli(process.argv.slice(2), (line) => console.log(line));
  process.exit(code);
}
