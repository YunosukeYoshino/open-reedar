# Apple agent PCC escalation policy

The `fm` CLI exposes two execution tiers: `system` (on-device, ~8K tokens) and `pcc` (Private Cloud Compute, ~32K). We expose a `system|pcc` model option on the apple agent with two automatic behaviors, because the right tier depends on prompt size rather than user preference:

- When a prompt exceeds the on-device cap, the run escalates to `pcc` automatically and tells the user via a localized notice — the alternative is a dead end (`err.tooLong`).
- Digest and map-reduce condense runs default to `pcc` when the apple agent is selected, since their prompts are structurally large.

PCC sends content to Apple's cloud, so the connection dialog states this plainly and the default tier remains `system`. When a `pcc` call fails (offline, usage limit): if the prompt fits the on-device cap we fall back to `system` with a notice; otherwise we surface a localized error suggesting retry. Silent fallbacks were rejected — the user must always know which tier answered.

Condensation notices are labeled separately from answer notices. Reader conversations and digests retain each distinct notice, including a chunk's on-device fallback, after the final answer completes. The CLI sends notices to its error writer; embedded callers that omit that writer receive notices through the output writer instead. The command-line entry point always supplies stderr, keeping JSON stdout free of notices.

`fm serve` (OpenAI-compatible endpoint) was considered and rejected for now: it adds a long-lived server process and auth surface for no gain over `fm respond` per call.
