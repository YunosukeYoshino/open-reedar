import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { createInterface } from "node:readline";
import { parse } from "smol-toml";
import { z } from "zod";
import type { Agent, Language } from "../../shared/schema";
import { t } from "../../shared/i18n";

export function agentEnvironment() {
  const env: NodeJS.ProcessEnv = {};
  // Authentication remains owned by the CLI. Do not inherit model API keys or arbitrary subprocess variables.
  for (const key of ["HOME", "USER", "LOGNAME", "PATH", "SHELL", "TMPDIR", "LANG", "LC_ALL", "CODEX_HOME", "CLAUDE_CONFIG_DIR", "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS"]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return env;
}

export const cliNames: Record<Agent, string> = { codex: "Codex", claude: "Claude Code", antigravity: "Antigravity", apple: "fm" };

export async function executable(agent: Agent) {
  const command = agent === "antigravity" ? "agy" : agent === "apple" ? "fm" : agent;
  const override = process.env[{ codex: "REEDAR_CODEX_BIN", claude: "REEDAR_CLAUDE_BIN", antigravity: "REEDAR_ANTIGRAVITY_BIN", apple: "REEDAR_APPLE_BIN" }[agent]];
  const paths = [
    ...(override ? [override] : []),
    ...(agent === "codex" ? ["/Applications/ChatGPT.app/Contents/Resources/codex", "/Applications/Codex.app/Contents/Resources/codex"] : []),
    ...(process.env.PATH ?? "").split(delimiter).filter(Boolean).map((directory) => join(directory, command)),
    join(homedir(), ".local/bin", command), join(homedir(), ".local/share/mise/shims", command), `/opt/homebrew/bin/${command}`, `/usr/local/bin/${command}`,
  ];
  for (const path of paths) {
    try { await access(path, constants.X_OK); return path; }
    catch { /* Try the next installed executable. */ }
  }
  throw new Error(t("en", "err.cliMissing", { name: cliNames[agent] }));
}

export async function codexArguments(configPath = join(process.env.CODEX_HOME || join(homedir(), ".codex"), "config.toml"), lang: Language = "en") {
  const args = ["app-server", "--stdio"];
  const settings = [
    "model_provider=\"openai\"", "features.shell_tool=false", "features.unified_exec=false",
    "features.code_mode=false", "features.code_mode_host=false", "features.plugins=false", "features.remote_plugin=false",
    "features.apps=false", "features.hooks=false", "features.multi_agent=false", "features.skip_host_skill_discovery=true",
    "features.skill_search=false", "features.shell_snapshot=false", "project_doc_max_bytes=0", "web_search=\"disabled\"",
    "approval_policy=\"on-request\"", "sandbox_mode=\"read-only\"",
  ];
  try {
    const config = z.object({ mcp_servers: z.record(z.string(), z.unknown()).optional() }).parse(parse(await readFile(configPath, "utf8")));
    for (const name of Object.keys(config.mcp_servers ?? {})) {
      if (!/^[a-zA-Z0-9_-]+$/.test(name)) throw new Error("Unsupported MCP configuration key");
      settings.push(`mcp_servers.${name}.enabled=false`);
    }
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
      throw new Error(t(lang, "err.codexConfig"), { cause: error });
    }
  }
  for (const setting of settings) args.push("-c", setting);
  return args;
}

export const claudeArguments = [
  "--print", "--output-format", "stream-json", "--verbose", "--include-partial-messages",
  "--restricted", "--tools", "", "--strict-mcp-config", "--mcp-config", "{\"mcpServers\":{}}",
  "--disallowedTools", "mcp__*", "--disable-slash-commands", "--no-chrome", "--no-session-persistence",
  "--settings", "{\"disableAllHooks\":true}", "--permission-mode", "dontAsk", "--permission-prompts", "none",
];

export function launch(path: string, args: string[], cwd: string) {
  const child = spawn(path, args, { cwd, env: agentEnvironment(), stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32" });
  child.stderr.on("data", () => {});
  return child;
}

export function terminate(child: ChildProcessWithoutNullStreams) {
  const kill = (signal: NodeJS.Signals) => {
    // Signal the whole group even when the leader already exited: background children
    // may still hold the output pipes and keep running inside the detached group.
    try {
      if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal);
      else child.kill(signal);
    } catch { /* The group is already gone. */ }
  };
  kill("SIGTERM");
  const timer = setTimeout(() => kill("SIGKILL"), 1500);
  timer.unref();
  child.once("close", () => clearTimeout(timer));
}

const rpcSchema = z.object({
  id: z.union([z.string(), z.number()]).optional(), method: z.string().optional(),
  params: z.unknown().optional(), result: z.unknown().optional(),
  error: z.object({ message: z.string() }).passthrough().optional(),
});
export type RpcMessage = z.infer<typeof rpcSchema>;

export class RpcClient {
  private nextId = 0;
  private pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private listeners = new Set<(message: RpcMessage) => void>();
  private closed = false;
  readonly process: ChildProcessWithoutNullStreams;

  private readonly lang: Language;

  constructor(path: string, args: string[], cwd: string, lang: Language = "en") {
    this.lang = lang;
    this.process = launch(path, args, cwd);
    const lines = createInterface({ input: this.process.stdout });
    lines.on("line", (line) => {
      let message: RpcMessage;
      try { message = rpcSchema.parse(JSON.parse(line)); }
      catch { return; }
      if (typeof message.id === "number" && !message.method) {
        const request = this.pending.get(message.id);
        if (request) {
          clearTimeout(request.timer);
          this.pending.delete(message.id);
          if (message.error) request.reject(new Error(message.error.message));
          else request.resolve(message.result);
        }
      } else for (const listener of this.listeners) listener(message);
    });
    this.process.on("error", () => this.fail(t(this.lang, "err.agentStart")));
    this.process.on("close", () => this.fail(t(this.lang, "err.agentClosed")));
  }

  private fail(message: string) {
    this.closed = true;
    for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(new Error(message)); }
    this.pending.clear();
  }

  subscribe(listener: (message: RpcMessage) => void) { this.listeners.add(listener); return () => this.listeners.delete(listener); }

  send(value: unknown) {
    if (this.closed) throw new Error(t(this.lang, "err.connectionClosed"));
    this.process.stdin.write(`${JSON.stringify(value)}\n`);
  }

  request(method: string, params: unknown, timeout = 20_000): Promise<unknown> {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(t(this.lang, "err.agentTimeout"))); }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      try { this.send({ id, method, params }); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }

  async initialize() {
    await this.request("initialize", { clientInfo: { name: "reedar", title: "Reedar", version: "0.1.0" } });
    this.send({ method: "initialized", params: {} });
  }

  close() { this.fail(t(this.lang, "err.connectionClosed")); terminate(this.process); }
}
