import { ArrowUp, Bot, Check, CircleAlert, LoaderCircle, Pause, Square, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { MarkdownText } from "./MarkdownText";
import type { Action, Agent, Article, Connection, Conversation, RunState } from "../shared/schema";
import { agentName } from "./format";

const labels = { running: "回答中", waiting: "確認待ち", completed: "完了", failed: "失敗", cancelled: "中止" };

export function RunStatus({ state }: { state: RunState }) {
  const Icon = state.status === "running" ? LoaderCircle : state.status === "completed" ? Check : state.status === "failed" ? CircleAlert : Pause;
  return <span className={`run-status status-${state.status}`}><Icon size={12} className={state.status === "running" ? "spin" : ""} />{state.status === "running" && state.phase === "fetching" ? "本文を取得中" : labels[state.status]}</span>;
}

type Props = { article: Article; agent: Agent; setAgent: (agent: Agent) => void; conversation: Conversation | undefined; connections: Connection[]; act: (action: Action) => Promise<void>; perform: (action: Action) => void; close: () => void };

export function AiPanel({ article, agent, setAgent, conversation, connections, act, perform, close }: Props) {
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
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
    catch (error: unknown) { setError(error instanceof Error ? error.message : "送信できませんでした。"); }
    finally { setSending(false); }
  }
  return <aside className="ai-panel" aria-label="AIとの会話"><header className="ai-heading"><div><Bot size={17} /><h2>AIと読む</h2></div><button className="icon-button" aria-label="AIパネルを閉じる" onClick={close}><X size={16} /></button></header>
    <div className="agent-picker" role="group" aria-label="エージェントを選択">{(["claude", "codex"] as const).map((value) => <button key={value} className={agent === value ? "active" : ""} aria-pressed={agent === value} onClick={() => setAgent(value)}><span className={`agent-symbol ${value}`}>{value === "claude" ? "✳" : "◇"}</span>{agentName[value]}</button>)}</div>
    {agent === "codex" ? <p className="model-caption">GPT-6-Luna</p> : null}
    <div className="source-context"><span className="context-dot" /><span>{article.title}</span></div>
    {conversation?.source.origin ? <p className="source-caption">{conversation.source.origin === "web" ? `リンク先本文 · ${conversation.source.text.length.toLocaleString()}文字` : "フィード本文のみ"}{conversation.source.fetchError ? <span>{conversation.source.fetchError}</span> : null}</p> : <p className="source-caption">質問時にリンク先の本文を取得します。</p>}
    <div className="conversation-scroll" ref={scroll} onScroll={() => { const element = scroll.current; if (element) follow.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80; }}>
      {!conversation?.messages.length ? <div className="ai-welcome"><Bot size={25} strokeWidth={1.4} /><h3>この記事を、もう少し深く。</h3><p>要点をつかむ。背景を知る。<br />気になった一文について尋ねる。</p><div className="suggestions">{["この記事を日本語で要約して", "この記事の背景を説明して", "この記事から何がわかる？"].map((text) => <button key={text} onClick={() => void send(text)} disabled={sending}>{text}<ArrowUp size={13} /></button>)}</div></div> : conversation.messages.map((message) => <div key={message.id} className={`message message-${message.role}`}><div className="message-label">{message.role === "user" ? "あなた" : message.model === "gpt-6-luna" ? "Codex · Luna" : message.model === "gpt-5.3-codex-spark" ? "Codex · Spark" : agentName[agent]}{message.role === "assistant" ? <><RunStatus state={message.state} />{message.sourceOrigin === "feed" ? <span>フィード本文のみ</span> : null}</> : null}</div>{message.role === "user" ? <p>{message.text}</p> : <><div className="markdown"><MarkdownText text={message.text} />{!message.text && message.state.status === "running" ? <span className="thinking">記事を読んでいます…</span> : null}</div>{message.state.status === "failed" || message.state.status === "waiting" ? <div className="run-notice" role="status">{message.state.status === "failed" ? message.state.error : message.state.reason}{message.state.status === "waiting" ? <div className="toolbar-group"><button className="text-button" commandfor="connections-dialog" command="show-modal">接続を確認</button><button className="text-button" aria-label="確認待ちを中止" onClick={() => perform({ type: "chat.stop", conversationId: conversation.id })}>中止</button></div> : null}</div> : null}</>}</div>)}
    </div>
    <div className="composer-area">{connection && connection.status !== "ready" ? <button className="connection-notice" commandfor="connections-dialog" command="show-modal"><CircleAlert size={13} />{connection.status === "checking" ? "接続を確認中" : "エージェントの接続を確認"}</button> : null}{error ? <p className="form-error" role="alert">{error}</p> : null}<form className="composer" onSubmit={(event) => { event.preventDefault(); void send(draft); }}><textarea aria-label="AIへの質問" placeholder="この記事について聞く…" value={draft} maxLength={4000} rows={3} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !event.nativeEvent.isComposing) { event.preventDefault(); void send(draft); } }} /><div className="composer-bottom"><span>⌘ Enter で送信</span>{running && conversation ? <button type="button" className="send-button stop-button" aria-label="回答を停止" onClick={() => perform({ type: "chat.stop", conversationId: conversation.id })}><Square size={13} fill="currentColor" /></button> : <button className="send-button" type="submit" aria-label="質問を送信" disabled={!draft.trim() || sending}><ArrowUp size={18} /></button>}</div></form><p className="privacy-note">記事本文とこの会話を{agentName[agent]}に送信します。</p></div>
  </aside>;
}
