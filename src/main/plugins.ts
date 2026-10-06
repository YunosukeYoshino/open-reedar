import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { access, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { parse } from "smol-toml";
import { ZodError } from "zod";
import { t } from "../shared/i18n";
import { pluginManifestSchema } from "../shared/schema";
import type { Language, PluginInfo, PluginManifest } from "../shared/schema";
import { terminate } from "./agents/process";

export async function scanPlugins(directory: string): Promise<PluginInfo[]> {
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); }
  catch { return []; }
  const plugins = await Promise.all(entries.filter((entry) => entry.isDirectory()).map((entry) => loadPlugin(directory, entry.name)));
  return plugins.sort((a, b) => a.name.localeCompare(b.name));
}

async function loadPlugin(directory: string, name: string): Promise<PluginInfo> {
  let raw: string;
  try { raw = await readFile(resolve(directory, name, "plugin.toml"), "utf8"); }
  catch { return { name, manifest: null, status: "error", error: "plugin.toml is missing or unreadable" }; }
  let manifest: PluginManifest;
  try { manifest = pluginManifestSchema.parse(parse(raw)); }
  catch (error) {
    const issue = error instanceof ZodError ? error.issues[0] : undefined;
    return { name, manifest: null, status: "error", error: issue ? `${issue.path.join(".")}: ${issue.message}` : "invalid plugin.toml" };
  }
  if (manifest.name !== name) return { name, manifest: null, status: "error", error: `manifest name "${manifest.name}" does not match directory "${name}"` };
  if (manifest.type === "panel") {
    try { await access(resolve(directory, name, manifest.entry)); }
    catch { return { name, manifest: null, status: "error", error: `entry file "${manifest.entry}" is missing` }; }
  }
  return { name, manifest, status: "ready" };
}

export function resolvePluginFile(directory: string, name: string, relPath: string) {
  if (!pluginNamePattern.test(name)) return null;
  const root = resolve(directory, name);
  const literal = resolve(root, relPath);
  if (!literal.startsWith(root + sep)) return null;
  // Realpath too: a symlink inside the plugin directory must not serve files outside it.
  // Missing files keep the literal path so the caller's readFile surfaces a plain 404.
  try {
    const realRoot = realpathSync(root);
    const path = realpathSync(literal);
    if (!path.startsWith(realRoot + sep)) return null;
    return path;
  } catch {
    return literal;
  }
}

const pluginNamePattern = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

// Write an uploaded plugin folder under <directory>/<name>/. Files only ever overwrite
// paths they name: files a previous install left behind (e.g. a local .env with the
// user's credentials) are kept. Rejects anything that would write outside the root.
export async function installPluginFiles(directory: string, name: string, files: { path: string; data: string }[], lang: Language) {
  if (!pluginNamePattern.test(name)) throw new Error(t(lang, "err.pluginName"));
  const root = resolve(directory, name);
  await mkdir(root, { recursive: true });
  const realRoot = realpathSync(root);
  for (const file of files) {
    const target = resolve(root, file.path);
    const unsafe = !target.startsWith(root + sep);
    const parent = dirname(target);
    await mkdir(parent, { recursive: true });
    // A planted symlink inside an existing plugin dir must not redirect the write outside it.
    const realParent = realpathSync(parent);
    if (unsafe || (realParent !== realRoot && !realParent.startsWith(realRoot + sep))) throw new Error(t(lang, "err.pluginPath", { path: file.path }));
    await writeFile(target, Buffer.from(file.data, "base64"));
  }
}

export function pluginCsp(manifest: PluginManifest) {
  const hosts = [...new Set(manifest.permissions.filter((permission) => permission.startsWith("net:")).map((permission) => permission.slice(4)))];
  // The CSP sandbox directive sandboxes the document itself: opened top-level it still gets an
  // opaque origin, so a panel page can never ride the app's session into the action API.
  // script-src allows inline because panels are single-file static HTML; connect-src is the real
  // exfiltration boundary — only 'self' plus the declared net: hosts.
  return `sandbox allow-scripts; default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'${hosts.map((host) => ` ${host}`).join("")}`;
}

type ActionManifest = Extract<PluginManifest, { type: "action" }>;
const invokeOutputLimit = 64 * 1024;
const invokeTimeout = 30_000;

// Action plugins are trusted local executables like git external commands: they run with the
// user's normal environment in their own directory, not the scrubbed agent sandbox environment.
export async function runActionPlugin(directory: string, manifest: ActionManifest, input: string, lang: Language, timeout = invokeTimeout, signal?: AbortSignal): Promise<{ status: number; stdout: string; stderr: string }> {
  const [file, ...args] = manifest.command;
  if (!file) throw new Error(t(lang, "err.pluginStart", { name: manifest.name }));
  const child = spawn(file, args, { cwd: directory, env: process.env, stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32" });
  child.stdin.on("error", () => { /* EPIPE when the child exits before reading stdin. */ });
  child.stdin.end(input);
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let stdoutLength = 0;
  let stderrLength = 0;
  child.stdout.on("data", (chunk: Buffer) => { const keep = Math.max(0, invokeOutputLimit - stdoutLength); stdoutLength += chunk.length; if (keep) stdout.push(chunk.subarray(0, keep)); });
  child.stderr.on("data", (chunk: Buffer) => { const keep = Math.max(0, invokeOutputLimit - stderrLength); stderrLength += chunk.length; if (keep) stderr.push(chunk.subarray(0, keep)); });
  return await new Promise((resolve, reject) => {
    let settled = false;
    const fail = (error: Error) => { if (!settled) { settled = true; clearTimeout(timer); terminate(child); reject(error); } };
    const timer = setTimeout(() => fail(new Error(t(lang, "err.pluginTimeout", { name: manifest.name }))), timeout);
    timer.unref();
    if (signal) { if (signal.aborted) fail(new Error(t(lang, "err.pluginAborted", { name: manifest.name }))); else signal.addEventListener("abort", () => fail(new Error(t(lang, "err.pluginAborted", { name: manifest.name }))), { once: true }); }
    child.once("error", () => fail(new Error(t(lang, "err.pluginStart", { name: manifest.name }))));
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Every exit resolves: the caller surfaces stderr, which is where the failure reason lives.
      resolve({ status: code ?? -1, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") });
    });
  });
}
