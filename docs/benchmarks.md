# Large-library benchmark

Last measured: **September 30, 2026 (UTC)**. Environment: macOS, Apple M4 (VM), 16 GB RAM, Bun 1.4.2. Reproduce with `bun run benchmark`, which generates deterministic seeded libraries of 1k / 10k / 50k articles across 30 feeds in a temp directory, then times the real persistence and snapshot code paths (`Store.open`, `store.save`, `stateSchema.parse`, `store.mergeFeed`, `Engine.snapshot` serialization as emitted over SSE). Nothing is mocked; only the data is synthetic.

Synthetic articles average ~13 KB on disk (title, excerpt, multi-paragraph `html` + `text`, occasional notes/highlights/reader content), so reader.json sizes below are the extreme end of a real library rather than a typical one. Timings are medians over repeated runs; peak RSS is the process maximum sampled every 4 ms during each phase. Re-runs vary roughly ±30% on the largest phases.

## Results

These measurements describe the JSON store before SQLite migration. The harness now gives each library size its own directory/database. RSS sampling reports the whole process, including allocations retained from earlier phases; synchronous operations can block the sampling timer, so these values are sampled observations rather than isolated phase maxima.

| phase | 1k | 10k | 50k |
| --- | --- | --- | --- |
| reader.json | 13.1 MB | 129 MB | 642 MB |

| time (ms) | 1k | 10k | 50k |
| --- | --- | --- | --- |
| readFile | 2.0 | 36.0 | 216 |
| JSON.parse | 4.9 | 45.3 | 241 |
| zod validate | 0.7 | 3.4 | 10.5 |
| Store.open | 16.5 | 235 | 1718 |
| store.save | 8.3 | 114 | 550 |
| snapshot serialize | 5.3 | 59.5 | 340 |
| mergeFeed ×1 | 0.2 | 0.9 | 5.4 |
| mergeFeed ×30 | 2.7 | 18.2 | 194 |

| peak RSS (MB) | 1k | 10k | 50k |
| --- | --- | --- | --- |
| readFile | 156 | 948 | 4155 |
| JSON.parse | 160 | 948 | 4262 |
| zod validate | 160 | 949 | 4276 |
| Store.open | 191 | 1228 | 5709 |
| store.save | 197 | 1251 | 5712 |
| snapshot serialize | 223 | 1413 | 6354 |
| mergeFeed ×1 | 224 | 1414 | 6356 |
| mergeFeed ×30 | 227 | 1420 | 6359 |

`Store.open` reads, parses, validates, normalizes interrupted conversations, then calls `store.save()` once, so its time ≈ read + JSON.parse + zod + save. `mergeFeed ×30` merges one refreshed batch (~24 items) per feed, the work `refreshFeeds` does across a full refresh round (network excluded; `store.save` per 4-feed batch is extra, ~8 saves ≈ 4.4 s at 50k).

## What breaks first

**Write amplification on every mutation.** Every `dispatch` ends in `store.save()`, which re-validates and re-serializes the *entire* library to disk: ~0.6–1 s of CPU at 50k for a single "mark read". A 30-feed auto-refresh pays it ~8 times in one round (~4.4 s CPU total, in bursts that block the main process).

**Full-snapshot serialization on every `changed()`.** Each emit serializes the whole state and sends it to every SSE client — ~0.3–0.5 s per emit at 50k. Most user actions emit once, but digest streaming calls `changed()` per delta and OPML import calls it per imported feed, so those flows degrade linearly with library size.

**Memory, not validation.** reader.json's in-memory object graph is ~7× its file size: 642 MB on disk → ~4.3 GB RSS after `JSON.parse`, peaking ~6.4 GB when the stringify result coexists with the graph during save/snapshot. On an 8 GB machine the app will start swapping somewhere in the 50–70k article range during `Store.open`. Zod validation is *not* the cost — it is ~11 ms at 50k.

**mergeFeed is not the bottleneck.** The per-merge `Map` rebuild plus full re-sort is ~5 ms at 50k (the array stays nearly sorted, so the re-sort is cheap in practice), and a whole 30-feed refresh merge is ~0.2 s. It is the one real super-linear term — O(feeds × n log n) — but it is dwarfed by the saves and snapshot emits that surround it.

In short: at ~10k articles everything still feels instant; at ~50k every mutation costs ~0.6 s of main-process CPU and the app needs several GB of transient memory. The scaling wall is the whole-library serialize-validate-write-emit cycle, not any single algorithm.

Possible follow-ups (measured here, not implemented): batch the per-feed `Map`+sort into one pass per refresh round (~15 lines, ~10× on merge time); debounce or journal `save()` so bursts of small mutations coalesce; send snapshot diffs instead of full snapshots over SSE.
