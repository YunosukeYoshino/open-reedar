# Large-library benchmark

Last measured: **September 30, 2026 (UTC)**. Environment: macOS, Apple M4 (VM), 16 GB RAM, Bun 1.4.2. Reproduce with `bun run benchmark`, which generates deterministic seeded libraries of 1k / 10k / 50k articles across 30 feeds in a temp directory, then times the real persistence and snapshot code paths (`Store.open`, `store.save`, `stateSchema.parse`, `store.mergeFeed`, `Engine.snapshot` serialization as emitted over SSE). Nothing is mocked; only the data is synthetic.

Synthetic articles average ~13 KB on disk (title, excerpt, multi-paragraph `html` + `text`, occasional notes/highlights/reader content), so reader.json sizes below are the extreme end of a real library rather than a typical one. Timings are medians over repeated runs; peak RSS is the process maximum sampled every 4 ms during each phase. Re-runs vary roughly ±30% on the largest phases.

## Results

| phase | 1k | 10k | 50k |
| --- | --- | --- | --- |
| reader.json | 12.8 MB | 131 MB | 647 MB |

| time (ms) | 1k | 10k | 50k |
| --- | --- | --- | --- |
| readFile | 1.7 | 31.2 | 378 |
| JSON.parse | 4.4 | 48.7 | 318 |
| zod validate | 1.6 | 3.2 | 14.4 |
| Store.open | 26.4 | 259 | 2157 |
| store.save | 9.3 | 96.2 | 685 |
| snapshot serialize | 5.0 | 60.0 | 437 |
| mergeFeed ×1 | 0.2 | 0.8 | 8.1 |
| mergeFeed ×30 | 2.9 | 18.1 | 295 |

| peak RSS (MB) | 1k | 10k | 50k |
| --- | --- | --- | --- |
| readFile | 161 | 932 | 4493 |
| JSON.parse | 164 | 933 | 4539 |
| zod validate | 164 | 933 | 4540 |
| Store.open | 207 | 1223 | 5130 |
| store.save | 209 | 1258 | 5367 |
| snapshot serialize | 234 | 1516 | 6091 |
| mergeFeed ×1 | 236 | 1519 | 6029 |
| mergeFeed ×30 | 239 | 1527 | 6038 |

`Store.open` reads, parses, validates, normalizes interrupted conversations, then calls `store.save()` once, so its time ≈ read + JSON.parse + zod + save. `mergeFeed ×30` merges one refreshed batch (~24 items) per feed, the work `refreshFeeds` does across a full refresh round (network excluded; `store.save` per 4-feed batch is extra, ~8 saves ≈ 5.5 s at 50k).

## What breaks first

**Write amplification on every mutation.** Every `dispatch` ends in `store.save()`, which re-validates and re-serializes the *entire* library to disk: ~0.7–1 s of CPU at 50k for a single "mark read". A 30-feed auto-refresh pays it ~8 times in one round (~5.5 s CPU total, in bursts that block the main process).

**Full-snapshot serialization on every `changed()`.** Each emit serializes the whole state and sends it to every SSE client — ~0.5 s per emit at 50k. Most user actions emit once, but digest streaming calls `changed()` per delta and OPML import calls it per imported feed, so those flows degrade linearly with library size.

**Memory, not validation.** reader.json's in-memory object graph is ~7× its file size: 647 MB on disk → ~4.5 GB RSS after `JSON.parse`, peaking ~6 GB when the stringify result coexists with the graph during save/snapshot. On an 8 GB machine the app will start swapping somewhere in the 50–70k article range during `Store.open`. Zod validation is *not* the cost — it is ~14 ms at 50k.

**mergeFeed is not the bottleneck.** The per-merge `Map` rebuild plus full re-sort is ~8 ms at 50k (the array stays nearly sorted, so the re-sort is cheap in practice), and a whole 30-feed refresh merge is ~0.3 s. It is the one real super-linear term — O(feeds × n log n) — but it is dwarfed by the saves and snapshot emits that surround it.

In short: at ~10k articles everything still feels instant; at ~50k every mutation costs ~1 s of main-process CPU and the app needs several GB of transient memory. The scaling wall is the whole-library serialize-validate-write-emit cycle, not any single algorithm.

Possible follow-ups (measured here, not implemented): batch the per-feed `Map`+sort into one pass per refresh round (~15 lines, ~10× on merge time); debounce or journal `save()` so bursts of small mutations coalesce; send snapshot diffs instead of full snapshots over SSE.
