import type { Article, Message } from "../shared/schema";

export const agentName = { claude: "Claude Code", codex: "Codex", antigravity: "Antigravity", apple: "Apple Intelligence" };
export function domain(url: string) { try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return ""; } }
export function readingMinutes(article: Article) { return Math.max(1, Math.ceil(article.text.length / 600)); }
export function isBusy(message: Message | undefined) { return message?.role === "assistant" && message.state.status === "running"; }
export function tone(name: string) { return (name.codePointAt(0) ?? 0) % 4; }
