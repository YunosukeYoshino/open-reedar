import { realpathSync } from "node:fs";
import { access, readdir, readFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { parse } from "smol-toml";
import { ZodError } from "zod";
import { pluginManifestSchema } from "../shared/schema";
import type { PluginInfo, PluginManifest } from "../shared/schema";

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
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(name)) return null;
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

export function pluginCsp(manifest: PluginManifest) {
  const hosts = [...new Set(manifest.permissions.filter((permission) => permission.startsWith("net:")).map((permission) => permission.slice(4)))];
  // The CSP sandbox directive sandboxes the document itself: opened top-level it still gets an
  // opaque origin, so a panel page can never ride the app's session into the action API.
  // script-src allows inline because panels are single-file static HTML; connect-src is the real
  // exfiltration boundary — only 'self' plus the declared net: hosts.
  return `sandbox allow-scripts; default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'${hosts.map((host) => ` ${host}`).join("")}`;
}
