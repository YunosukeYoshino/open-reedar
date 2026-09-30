import type { Language } from "../../shared/schema";
import { t } from "../../shared/i18n";
import { LocalizedError, sessionProfile } from "./reader";

export type CondenseRunner = (prompt: string, signal: AbortSignal) => Promise<string>;

// Two-pass map-reduce: chunks sized to the agent's prompt cap are condensed sequentially and
// concatenated; a second pass runs only if the combined result still misses the budget.
export async function condense(text: string, budget: number, cap: number, run: CondenseRunner, signal: AbortSignal, lang: Language = "en"): Promise<string> {
  if (text.length <= budget) return text;
  if (budget <= 0) return "";
  const instructions = sessionProfile("condense", lang).instructions;
  const chunkSize = cap - instructions.length - 200;
  if (chunkSize <= 0) return text.slice(0, budget);
  for (let pass = 0; pass < 2 && text.length > budget; pass++) {
    const parts: string[] = [];
    const total = Math.ceil(text.length / chunkSize);
    for (let index = 0; index < total; index++) {
      if (signal.aborted) throw new LocalizedError(t(lang, "err.aborted"));
      const prompt = `${instructions}\n\n${t(lang, "prompt.condenseChunk", { index: index + 1, total })}\n\n${text.slice(index * chunkSize, (index + 1) * chunkSize)}`;
      parts.push((await run(prompt, signal)).trim());
    }
    text = parts.join("\n\n");
  }
  // ponytail: two passes can still miss the budget when the agent expands instead of condensing; a hard truncate keeps the prompt under the cap. Upgrade path is looping until it fits or shrinking chunks.
  if (text.length > budget) text = text.slice(0, budget);
  return text;
}
