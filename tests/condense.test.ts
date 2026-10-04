import { describe, expect, test } from "bun:test";
import { condense } from "../src/main/agents/condense";
import { sessionProfile } from "../src/main/agents/reader";

const cap = 30_000;

describe("condense", () => {
  test("returns text unchanged and never calls the runner when it fits the budget", async () => {
    let calls = 0;
    const result = await condense("short article", 100, cap, async () => { calls++; return "unused"; }, new AbortController().signal);
    expect(result).toBe("short article");
    expect(calls).toBe(0);
  });

  test("splits oversized text into cap-sized chunks and concatenates the condensed parts", async () => {
    const prompts: string[] = [];
    const result = await condense("a".repeat(80_000), 20_000, cap, async (prompt) => { prompts.push(prompt); return `part${prompts.length}`; }, new AbortController().signal);
    expect(result).toBe("part1\n\npart2\n\npart3");
    expect(prompts.length).toBe(3);
    for (const prompt of prompts) {
      expect(prompt.length).toBeLessThan(cap);
      expect(prompt).toContain(sessionProfile("condense").instructions);
    }
    expect(prompts[0]).toContain("Excerpt 1 of 3");
    expect(prompts[2]).toContain("Excerpt 3 of 3");
  });

  test("repeats the pass once when the combined result still misses the budget, then truncates hard", async () => {
    const prompts: string[] = [];
    const result = await condense("a".repeat(60_000), 5_000, cap, async (prompt) => { prompts.push(prompt); return prompt; }, new AbortController().signal);
    // Echoing the prompt keeps every pass over budget: two passes then a hard truncate.
    expect(prompts.length).toBe(6);
    expect(result.length).toBe(5_000);
  });

  test("stops between chunks when the signal aborts", async () => {
    const controller = new AbortController();
    let calls = 0;
    await expect(condense("a".repeat(80_000), 20_000, cap, async () => { calls++; controller.abort(); return "part"; }, controller.signal)).rejects.toThrow("Cancelled");
    expect(calls).toBe(1);
  });

  test("rejects immediately on a pre-aborted signal without calling the runner", async () => {
    let calls = 0;
    const controller = new AbortController();
    controller.abort();
    await expect(condense("a".repeat(80_000), 20_000, cap, async () => { calls++; return "part"; }, controller.signal)).rejects.toThrow("Cancelled");
    expect(calls).toBe(0);
  });
});
