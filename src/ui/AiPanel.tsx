import { ArrowUp, Bot, Check, CircleAlert, ClipboardCopy, LoaderCircle, Pause, Square, Trash2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { MarkdownText } from "./MarkdownText";
import type { Action, Agent, AppleModel, Article, Connection, Conversation, RunState } from "../shared/schema";
import { agentName } from "./format";
import { useT } from "./i18n";

export function RunStatus({ state }: { state: RunState }) {
  const t = useT();
  const Icon = state.status === "running" ? LoaderCircle : state.status === "completed" ? Check : state.status === "failed" ? CircleAlert : Pause;
  return <span className={`run-status status-${state.status}`}><Icon size={12} className={state.status === "running" ? "spin" : ""} />{state.status === "running" && state.phase === "fetching" ? t("run.fetching") : t(`run.${state.status}`)}</span>;
}

type Props = { article: Article; agent: Agent; setAgent: (agent: Agent) => void; conversation: Conversation | undefined; connections: Connection[]; appleModel: AppleModel; act: (action: Action) => Promise<unknown>; perform: (action: Action) => void; close: () => void };

export function AiPanel({ article, agent, setAgent, conversation, connections, appleModel, act, perform, close }: Props) {
  const t = useT();
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const scroll = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const last = conversation?.messages.at(-1);
  const running = last?.role === "assistant" && last.state.status === "running";
  const connection = connections.find((item) => item.agent === agent);
  useEffect(() => { if (follow.current) scroll.current?.scrollTo({ top: scroll.current.scrollHeight }); }, [last?.text, last?.id]);
  async function send(text: string) {
    if (!text.trim() || sending || running) return;
    setSending(true); setError(null); follow.current = true;
    try { await act({ type: "chat.send", articleId: article.id, agent, text }); setDraft(""); }
    catch (error: unknown) { setError(error instanceof Error ? error.message : t("ai.sendFailed")); }
    finally { setSending(false); }
  }
  const displayAgent = agent === "codex" ? t("reader.agentLabel") : agentName[agent];
  async function deleteConversation() {
    if (!conversation || deleting) return;
    setDeleting(true); setError(null);
    try { await act({ type: "chat.delete", conversationId: conversation.id }); setConfirmingDelete(false); }
    catch (cause: unknown) { setError(cause instanceof Error ? cause.message : t("ai.sendFailed")); }
    finally { setDeleting(false); }
  }
  function copyConversation() {
    if (!conversation?.messages.length) return;
    const body = conversation.messages.map((message) => `### ${message.role === "user" ? t("ai.you") : displayAgent}\n\n${message.text}`).join("\n\n");
    void navigator.clipboard.writeText(`# ${article.title}\n${article.url}\n\n${body}`).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); });
  }
  return <aside className="ai-panel" aria-label={t("ai.panel")}><header className="ai-heading"><div><Bot size={17} /><h2>{t("reader.readWithAi")}</h2></div><div className="toolbar-group">{conversation ? <button className="icon-button" aria-label={t("ai.deleteConversation")} title={t("ai.deleteConversation")} onClick={() => setConfirmingDelete(true)}><Trash2 size={15} /></button> : null}<button className="icon-button" aria-label={t("ai.copyConversation")} title={copied ? t("ai.copied") : t("ai.copyConversation")} disabled={!conversation?.messages.length} onClick={copyConversation}>{copied ? <Check size={15} /> : <ClipboardCopy size={15} />}</button><button className="icon-button" aria-label={t("ai.closePanel")} onClick={close}><X size={16} /></button></div></header>
    <div className="agent-picker" role="group" aria-label={t("ai.pickAgent")}>{(["apple", "claude", "codex"] as const).map((value) => <button key={value} className={agent === value ? "active" : ""} aria-pressed={agent === value} onClick={() => setAgent(value)}><span className={`agent-symbol ${value}`}>{value === "claude" ? "✳" : value === "codex" ? "◇" : "✦"}</span>{agentName[value]}</button>)}</div>
    {agent === "codex" ? <p className="model-caption">GPT-6-Luna</p> : agent === "apple" ? <p className="model-caption">{t(appleModel === "pcc" ? "ai.appleCloud" : "ai.appleLocal")}</p> : null}
    <div className="source-context"><span className="context-dot" /><span>{article.title}</span></div>
    {conversation?.source.origin ? <p className="source-caption">{conversation.source.origin === "web" ? t("ai.sourceCaptionWeb", { count: conversation.source.text.length.toLocaleString() }) : t("ai.feedOnly")}{conversation.source.fetchError ? <span>{conversation.source.fetchError}</span> : null}</p> : <p className="source-caption">{t("ai.sourceCaptionPending")}</p>}
    {confirmingDelete && conversation ? <div className="run-notice" role="alert"><p>{t("ai.deleteConfirm")}</p><div className="toolbar-group"><button className="text-button" disabled={deleting} onClick={() => void deleteConversation()}>{t("ai.delete")}</button><button className="text-button" disabled={deleting} onClick={() => setConfirmingDelete(false)}>{t("app.cancel")}</button></div></div> : null}
    <div className="conversation-scroll" ref={scroll} onScroll={() => { const element = scroll.current; if (element) follow.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80; }}>
      {!conversation?.messages.length ? <div className="ai-welcome"><Bot size={25} strokeWidth={1.4} /><h3>{t("ai.welcomeTitle")}</h3><p>{t("ai.welcomeBody")}</p><div className="suggestions">{([t("ai.suggestSummary"), t("ai.suggestBackground"), t("ai.suggestTakeaway"), t("ai.suggestTranslate")]).map((text) => <button key={text} onClick={() => void send(text)} disabled={sending}>{text}<ArrowUp size={13} /></button>)}</div></div> : conversation.messages.map((message) => <div key={message.id} className={`message message-${message.role}`}><div className="message-label">{message.role === "user" ? t("ai.you") : message.model === "gpt-6-luna" ? t("reader.agentLabel") : message.model === "gpt-5.3-codex-spark" ? t("reader.agentLabelSpark") : agentName[agent]}{message.role === "assistant" ? <><RunStatus state={message.state} />{message.partial ? <span className="partial-badge">{t("ai.partialAnswer")}</span> : null}{message.sourceOrigin === "feed" ? <span>{t("ai.feedOnly")}</span> : null}</> : null}</div>{message.role === "user" ? <p>{message.text}</p> : <><div className="markdown"><MarkdownText text={message.text} />{!message.text && message.state.status === "running" ? <span className="thinking">{t("ai.thinking")}</span> : null}</div>{message.state.status === "failed" || message.state.status === "waiting" ? <div className="run-notice" role="status">{message.state.status === "failed" ? message.state.error : message.state.reason}{message.state.status === "waiting" ? <div className="toolbar-group"><button className="text-button" commandfor="connections-dialog" command="show-modal">{t("ai.checkConnection")}</button><button className="text-button" aria-label={t("ai.cancelWaiting")} onClick={() => perform({ type: "chat.stop", conversationId: conversation.id })}>{t("ai.cancelWaiting")}</button></div> : null}</div> : null}{message.role === "assistant" && message.notice ? <div className="run-notice" role="status">{message.notice}</div> : null}</>}</div>)}
    </div>
    <div className="composer-area">{connection && connection.status !== "ready" ? <button className="connection-notice" commandfor="connections-dialog" command="show-modal"><CircleAlert size={13} />{connection.status === "checking" ? t("ai.checkingConnection") : t("ai.connectionNotice")}</button> : null}{error ? <p className="form-error" role="alert">{error}</p> : null}<form className="composer" onSubmit={(event) => { event.preventDefault(); void send(draft); }}><textarea aria-label={t("ai.question")} placeholder={t("ai.askPlaceholder")} value={draft} maxLength={4000} rows={3} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !event.nativeEvent.isComposing) { event.preventDefault(); void send(draft); } }} /><div className="composer-bottom"><span>{t("ai.sendHint")}</span>{running && conversation ? <button type="button" className="send-button stop-button" aria-label={t("ai.stopAnswer")} onClick={() => perform({ type: "chat.stop", conversationId: conversation.id })}><Square size={13} fill="currentColor" /></button> : <button className="send-button" type="submit" aria-label={t("ai.sendQuestion")} disabled={!draft.trim() || sending}><ArrowUp size={18} /></button>}</div></form><p className="privacy-note">{t("ai.privacyNote", { agent: displayAgent })}</p></div>
  </aside>;
}
