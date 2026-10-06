import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pluginCsp, resolvePluginFile, scanPlugins } from "../src/main/plugins";
import { pluginManifestSchema } from "../src/shared/schema";

const directory = await mkdtemp(join(tmpdir(), "reedar-plugins-test-"));
const pluginsDirectory = join(directory, "plugins");
afterAll(async () => { await Bun.spawn(["trash", directory]).exited; });

beforeAll(async () => {
  await mkdir(join(pluginsDirectory, "word-count"), { recursive: true });
  await writeFile(join(pluginsDirectory, "word-count", "plugin.toml"), 'name = "word-count"\ntitle = "Word Count"\ntype = "panel"\npermissions = ["articles.read", "net:api.example.com"]\n');
  await writeFile(join(pluginsDirectory, "word-count", "index.html"), "<title>wc</title>");
  await mkdir(join(pluginsDirectory, "word-count", "sub"), { recursive: true });
  await writeFile(join(pluginsDirectory, "word-count", "sub", "app.js"), "console.log(1)");
  await mkdir(join(pluginsDirectory, "saver"), { recursive: true });
  await writeFile(join(pluginsDirectory, "saver", "plugin.toml"), 'name = "saver"\ntype = "action"\ncommand = ["./save.sh"]\n');
  await mkdir(join(pluginsDirectory, "broken"), { recursive: true });
  await writeFile(join(pluginsDirectory, "broken", "plugin.toml"), 'name = "broken"\ntype = "widget"\n');
  await mkdir(join(pluginsDirectory, "no-manifest"), { recursive: true });
  await mkdir(join(pluginsDirectory, "mismatch"), { recursive: true });
  await writeFile(join(pluginsDirectory, "mismatch", "plugin.toml"), 'name = "other"\ntype = "panel"\n');
  await mkdir(join(pluginsDirectory, "no-entry"), { recursive: true });
  await writeFile(join(pluginsDirectory, "no-entry", "plugin.toml"), 'name = "no-entry"\ntype = "panel"\n');
  await writeFile(join(directory, "secret.txt"), "SECRET CANARY");
  await symlink(join(directory, "secret.txt"), join(pluginsDirectory, "word-count", "leak"));
  await writeFile(join(pluginsDirectory, "stray.txt"), "not a plugin");
});

describe("plugin manifests", () => {
  const base = { name: "word-count", title: "Word Count" };
  test("accepts panel and action shapes with defaults", () => {
    expect(pluginManifestSchema.parse({ ...base, type: "panel" })).toMatchObject({ entry: "index.html", placement: "sidebar", permissions: [] });
    expect(pluginManifestSchema.parse({ ...base, type: "action", command: ["./save.sh"] })).toMatchObject({ command: ["./save.sh"] });
  });
  test("rejects an unknown type", () => {
    expect(pluginManifestSchema.safeParse({ ...base, type: "widget" }).success).toBe(false);
  });
  test("requires a non-empty command on actions", () => {
    expect(pluginManifestSchema.safeParse({ ...base, type: "action" }).success).toBe(false);
    expect(pluginManifestSchema.safeParse({ ...base, type: "action", command: [] }).success).toBe(false);
  });
  test("rejects undeclared permissions and malformed hosts", () => {
    const manifest = { ...base, type: "panel" };
    expect(pluginManifestSchema.safeParse({ ...manifest, permissions: ["root"] }).success).toBe(false);
    expect(pluginManifestSchema.safeParse({ ...manifest, permissions: ["net:"] }).success).toBe(false);
    expect(pluginManifestSchema.safeParse({ ...manifest, permissions: ["net:-bad-.com"] }).success).toBe(false);
    expect(pluginManifestSchema.safeParse({ ...manifest, permissions: ["net:api.example.com", "articles.read", "dispatch"] }).success).toBe(true);
  });
  test("rejects unsafe names and traversing entries", () => {
    expect(pluginManifestSchema.safeParse({ ...base, name: "../evil", type: "panel" }).success).toBe(false);
    expect(pluginManifestSchema.safeParse({ ...base, name: "has space", type: "panel" }).success).toBe(false);
    expect(pluginManifestSchema.safeParse({ ...base, type: "panel", entry: "../app/index.html" }).success).toBe(false);
    expect(pluginManifestSchema.safeParse({ ...base, type: "panel", entry: "/abs.html" }).success).toBe(false);
    expect(pluginManifestSchema.safeParse({ ...base, type: "panel", entry: "sub/app.html" }).success).toBe(true);
  });
});

describe("scanPlugins", () => {
  test("loads ready plugins and surfaces per-plugin errors without aborting", async () => {
    const plugins = await scanPlugins(pluginsDirectory);
    const byName = new Map(plugins.map((plugin) => [plugin.name, plugin]));
    expect(byName.get("word-count")).toMatchObject({ status: "ready", manifest: { type: "panel", title: "Word Count" } });
    expect(byName.get("saver")).toMatchObject({ status: "ready", manifest: { type: "action", command: ["./save.sh"] } });
    expect(byName.get("broken")).toMatchObject({ status: "error", manifest: null });
    expect(byName.get("no-manifest")).toMatchObject({ status: "error", manifest: null });
    expect(byName.get("mismatch")?.error).toContain("does not match");
    expect(byName.get("no-entry")?.error).toContain("missing");
    expect(byName.has("stray.txt")).toBe(false);
    expect(plugins[0]?.name).toBe("broken");
  });
  test("returns an empty list when the directory does not exist", async () => {
    expect(await scanPlugins(join(directory, "missing"))).toEqual([]);
  });
});

describe("resolvePluginFile", () => {
  test("resolves nested files inside the plugin directory", () => {
    expect(resolvePluginFile(pluginsDirectory, "word-count", "sub/app.js")).toBe(realpathSync(join(pluginsDirectory, "word-count", "sub", "app.js")));
  });
  test("rejects traversal, absolute paths, and unsafe names", () => {
    expect(resolvePluginFile(pluginsDirectory, "word-count", "../private.txt")).toBeNull();
    expect(resolvePluginFile(pluginsDirectory, "word-count", "sub/../../private.txt")).toBeNull();
    expect(resolvePluginFile(pluginsDirectory, "word-count", "/etc/passwd")).toBeNull();
    expect(resolvePluginFile(pluginsDirectory, "word-count", "..")).toBeNull();
    expect(resolvePluginFile(pluginsDirectory, "..", "plugin.toml")).toBeNull();
    expect(resolvePluginFile(pluginsDirectory, "has space", "index.html")).toBeNull();
    expect(resolvePluginFile(pluginsDirectory, "word-count", "")).toBeNull();
  });
  test("rejects symlinks that escape the plugin directory", () => {
    expect(resolvePluginFile(pluginsDirectory, "word-count", "leak")).toBeNull();
  });
});

describe("pluginCsp", () => {
  test("locks down the panel and opens connect-src per declared host", () => {
    const manifest = pluginManifestSchema.parse({ name: "wc", type: "panel", permissions: ["articles.read", "net:api.example.com", "net:cdn.example.org", "net:api.example.com"] });
    expect(pluginCsp(manifest)).toBe("sandbox allow-scripts; default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self' api.example.com cdn.example.org");
  });
  test("defaults to connect-src 'self' only", () => {
    expect(pluginCsp(pluginManifestSchema.parse({ name: "wc", type: "panel" }))).toContain("connect-src 'self'");
  });
});
