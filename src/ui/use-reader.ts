import { useCallback, useEffect, useRef, useState } from "react";
import { z } from "zod";
import { t } from "../shared/i18n";
import { updateSchema } from "../shared/schema";
import type { Action, Language, Snapshot } from "../shared/schema";

export function useReader() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const language = useRef<Language>("en");
  language.current = snapshot?.state.language ?? "en";
  useEffect(() => {
    const stream = new EventSource("/api/events");
    stream.onopen = () => setConnected(true);
    stream.onerror = () => setConnected(false);
    stream.onmessage = (message) => {
      try {
        const update = updateSchema.parse(JSON.parse(message.data));
        if (update.type === "snapshot") setSnapshot(update.snapshot);
        else setSnapshot((current) => current ? {
          ...current,
          state: { ...current.state, conversations: current.state.conversations.map((conversation) => conversation.id === update.conversation.id ? update.conversation : conversation) },
        } : current);
      } catch { setError(t(language.current, "net.stateUnreadable")); }
    };
    return () => stream.close();
  }, []);

  const act = useCallback(async (action: Action) => {
    const response = await fetch("/api/action", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(action) });
    if (!response.ok) {
      const result = z.object({ error: z.string() }).safeParse(await response.json());
      throw new Error(result.success ? result.data.error : t(language.current, "net.actionFailed"));
    }
  }, []);

  const perform = useCallback((action: Action) => {
    void act(action).catch((error: unknown) => setError(error instanceof Error ? error.message : t(language.current, "net.performFailed")));
  }, [act]);
  return { snapshot, connected, error, setError, act, perform };
}
