import { FileText, Square } from "lucide-react";
import { useState } from "react";
import type { Action, Agent, Article, Conversation } from "../shared/schema";
import { RunStatus } from "./AiPanel";
import { agentName } from "./format";
import { MarkdownText } from "./MarkdownText";

type Props = { article: Article; agent: Agent; conversation: Conversation | undefined; act: (action: Action) => Promise<void>; perform: (action: Action) => void };

export function ArticleContent({ article, agent, conversation, act, perform }: Props) {
  const [showSummary, setShowSummary] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const summary = conversation?.messages.findLast((message) => message.role === "assistant" && message.purpose === "summary");
  const last = conversation?.messages.at(-1);
  const busy = sending || last?.role === "assistant" && last.state.status === "running";
  async function summarize() {
    if (busy) return;
    setShowSummary(true); setSending(true); setError(null);
    try { await act({ type: "chat.summarize", articleId: article.id, agent }); }
    catch (error: unknown) { setError(error instanceof Error ? error.message : "要約を開始できませんでした。"); }
    finally { setSending(false); }
  }
  return <>
    <div className="summary-toolbar"><button className="summary-toggle" aria-label={showSummary ? "フィード本文に戻る" : "記事を要約"} aria-pressed={showSummary} disabled={!showSummary && !summary && busy} onClick={() => { if (showSummary || summary) setShowSummary(!showSummary); else void summarize(); }}><FileText size={15} />{showSummary ? "フィード本文に戻る" : summary ? "要約を読む" : "要約する"}</button><span>{agent === "codex" ? "Codex · Luna" : agentName[agent]}{!summary ? "に記事本文を送信" : ""}</span></div>
    {showSummary ? <section className="reader-summary" aria-label="記事の要約">
      <div className="summary-heading"><h2>要約</h2>{summary?.role === "assistant" ? <RunStatus state={summary.state} /> : null}<button className="text-button" disabled={busy} onClick={() => void summarize()}>再要約</button></div>
      {error ? <p className="form-error" role="alert">{error}</p> : null}
      {summary?.role === "assistant" ? <>
        <div className="markdown"><MarkdownText text={summary.text} /></div>
        {summary.state.status === "running" && !summary.text ? <p className="thinking" role="status">{summary.state.phase === "fetching" ? "リンク先から本文を取得しています…" : "記事を要約しています…"}</p> : null}
        {summary.state.status === "failed" || summary.state.status === "waiting" ? <div className="run-notice" role="status">{summary.state.status === "failed" ? summary.state.error : summary.state.reason}{summary.state.status === "waiting" ? <button className="text-button" commandfor="connections-dialog" command="show-modal">接続を確認</button> : null}</div> : null}
        {conversation && (summary.state.status === "running" || summary.state.status === "waiting") ? <button className="text-button summary-stop" onClick={() => perform({ type: "chat.stop", conversationId: conversation.id })}><Square size={12} />要約を停止</button> : null}
        {summary.sourceOrigin && conversation ? <div className="summary-source"><p>{summary.sourceOrigin === "web" ? "リンク先本文" : "フィード本文のみ"} · {(summary.sourceOrigin === "feed" ? conversation.previousSource ?? conversation.source : conversation.source).text.length.toLocaleString()}文字を使用</p>{summary.sourceOrigin === "feed" ? <p className="run-notice">リンク先本文を取得できなかったため、フィード本文だけに基づく要約です。</p> : null}<details><summary>AIに渡した本文を確認</summary><div>{(summary.sourceOrigin === "feed" ? conversation.previousSource ?? conversation.source : conversation.source).text}</div></details></div> : null}
      </> : !error ? <p className="thinking" role="status">要約を準備しています…</p> : null}
    </section> : <><div className="article-html" dangerouslySetInnerHTML={{ __html: article.html }} />{!article.text ? <p className="muted">このフィードには本文が含まれていません。</p> : null}</>}
  </>;
}
