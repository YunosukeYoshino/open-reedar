import { FileText, Square } from "lucide-react";
import { useState } from "react";
import type { Action, Agent, Article, Conversation } from "../shared/schema";
import { RunStatus } from "./AiPanel";
import { agentName } from "./format";
import { useT } from "./i18n";
import { MarkdownText } from "./MarkdownText";

type Props = { article: Article; agent: Agent; conversation: Conversation | undefined; act: (action: Action) => Promise<void>; perform: (action: Action) => void; webView: boolean };

export function ArticleContent({ article, agent, conversation, act, perform, webView }: Props) {
  const t = useT();
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
    catch (error: unknown) { setError(error instanceof Error ? error.message : t("ai.sendFailed")); }
    finally { setSending(false); }
  }
  return <>
    <div className="summary-toolbar"><button className="summary-toggle" aria-label={showSummary ? t("reader.backToFeed") : t("reader.summarize")} aria-pressed={showSummary} disabled={!showSummary && !summary && busy} onClick={() => { if (showSummary || summary) setShowSummary(!showSummary); else void summarize(); }}><FileText size={15} />{showSummary ? t("reader.backToFeed") : summary ? t("reader.readSummary") : t("reader.summarize")}</button><span>{!summary ? t("reader.summarizeSend", { agent: agent === "codex" ? t("reader.agentLabel") : agentName[agent] }) : agent === "codex" ? t("reader.agentLabel") : agentName[agent]}</span></div>
    {showSummary ? <section className="reader-summary" aria-label={t("reader.summaryAria")}>
      <div className="summary-heading"><h2>{t("reader.summaryTitle")}</h2>{summary?.role === "assistant" ? <RunStatus state={summary.state} /> : null}{summary?.role === "assistant" && summary.partial ? <span className="partial-badge">{t("ai.partialAnswer")}</span> : null}<button className="text-button" disabled={busy} onClick={() => void summarize()}>{t("reader.reSummarize")}</button></div>
      {error ? <p className="form-error" role="alert">{error}</p> : null}
      {summary?.role === "assistant" ? <>
        <div className="markdown"><MarkdownText text={summary.text} /></div>
        {summary.state.status === "running" && !summary.text ? <p className="thinking" role="status">{summary.state.phase === "fetching" ? t("run.fetching") : t("reader.summarizing")}</p> : null}
        {summary.state.status === "failed" || summary.state.status === "waiting" ? <div className="run-notice" role="status">{summary.state.status === "failed" ? summary.state.error : summary.state.reason}{summary.state.status === "waiting" ? <button className="text-button" commandfor="connections-dialog" command="show-modal">{t("ai.checkConnection")}</button> : null}</div> : null}
        {conversation && (summary.state.status === "running" || summary.state.status === "waiting") ? <button className="text-button summary-stop" onClick={() => perform({ type: "chat.stop", conversationId: conversation.id })}><Square size={12} />{t("reader.stopSummary")}</button> : null}
        {summary.sourceOrigin && conversation ? <div className="summary-source"><p>{t("reader.usedChars", { origin: summary.sourceOrigin === "web" ? t("reader.sourceWeb") : t("reader.sourceFeed"), count: (summary.sourceOrigin === "feed" ? conversation.previousSource ?? conversation.source : conversation.source).text.length.toLocaleString() })}</p>{summary.sourceOrigin === "feed" ? <p className="run-notice">{t("reader.feedOnlyNote")}</p> : null}<details><summary>{t("reader.suppliedText", { count: (summary.sourceOrigin === "feed" ? conversation.previousSource ?? conversation.source : conversation.source).text.length.toLocaleString() })}</summary><div>{(summary.sourceOrigin === "feed" ? conversation.previousSource ?? conversation.source : conversation.source).text}</div></details></div> : null}
      </> : !error ? <p className="thinking" role="status">{t("reader.preparing")}</p> : null}
    </section> : <><div className="article-html" dangerouslySetInnerHTML={{ __html: webView && article.readerHtml ? article.readerHtml : article.html }} />{!article.text ? <p className="muted">{t("reader.noBodyText")}</p> : null}</>}
  </>;
}
