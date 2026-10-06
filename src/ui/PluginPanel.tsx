import { useEffect, useRef } from "react";
import { z } from "zod";
import { actionSchema, pluginBridgeRequestSchema } from "../shared/schema";
import type { Action, Article, PluginInfo, ReaderState } from "../shared/schema";
import { useT } from "./i18n";

type Props = { plugin: PluginInfo; article: Article | undefined; feeds: ReaderState["feeds"]; folders: ReaderState["folders"]; act: (action: Action) => Promise<unknown> };

export function PluginPanel({ plugin, article, feeds, folders, act }: Props) {
  const t = useT();
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const initialized = useRef(false);
  const manifest = plugin.manifest?.type === "panel" ? plugin.manifest : null;
  const canRead = manifest?.permissions.includes("articles.read") ?? false;
  const canDispatch = manifest?.permissions.includes("dispatch") ?? false;
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const frame = iframeRef.current;
      if (!frame || event.source !== frame.contentWindow) return;
      const parsed = pluginBridgeRequestSchema.safeParse(event.data);
      if (!parsed.success) return;
      void handle(parsed.data.id, parsed.data.method, parsed.data.params);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  });
  useEffect(() => { if (initialized.current) postInit(); }, [article]);
  if (!manifest) return null;

  function respond(id: string | number, value: { result?: unknown; error?: string }) {
    iframeRef.current?.contentWindow?.postMessage({ id, ...value }, "*");
  }
  function bridgeState() {
    return canRead ? { article: article ?? null, feeds, folders } : { article: null, feeds: [], folders: [] };
  }
  function postInit() {
    iframeRef.current?.contentWindow?.postMessage({ type: "init", state: bridgeState() }, "*");
  }
  async function forward(id: string | number, action: Action) {
    try {
      const outcome = await act(action) as { result?: unknown };
      respond(id, { result: outcome?.result ?? null });
    } catch (error) { respond(id, { error: error instanceof Error ? error.message : t("err.requestFailed") }); }
  }
  async function handle(id: string | number, method: string, params: unknown) {
    switch (method) {
      case "ready":
        initialized.current = true;
        postInit();
        respond(id, { result: null });
        return;
      case "getState":
        if (!canRead) { respond(id, { error: t("err.pluginPermission", { permission: "articles.read" }) }); return; }
        respond(id, { result: bridgeState() });
        return;
      case "getArticle": {
        if (!canRead) { respond(id, { error: t("err.pluginPermission", { permission: "articles.read" }) }); return; }
        const parsed = z.object({ id: z.string().min(1) }).safeParse(params);
        if (!parsed.success) { respond(id, { error: t("err.badInput") }); return; }
        await forward(id, { type: "article.get", id: parsed.data.id });
        return;
      }
      case "dispatch": {
        if (!canDispatch) { respond(id, { error: t("err.pluginPermission", { permission: "dispatch" }) }); return; }
        const parsed = actionSchema.safeParse(params);
        if (!parsed.success) { respond(id, { error: t("err.badInput") }); return; }
        // The dispatch permission must not let a panel install or overwrite plugin code;
        // plugins.install stays a user-only action.
        if (parsed.data.type === "plugins.install") { respond(id, { error: t("err.pluginPermission", { permission: "plugins.install" }) }); return; }
        await forward(id, parsed.data);
        return;
      }
      default:
        respond(id, { error: t("err.pluginMethod") });
    }
  }

  return <iframe ref={iframeRef} className="plugin-frame" title={manifest.title ?? plugin.name} sandbox="allow-scripts" src={`/plugins/${plugin.name}/${manifest.entry}`} />;
}
