# .conveyor — autonomous issue → PR → auto-merge pipeline config

Three layers: a resident conductor (runs elsewhere — local Hermes or a
long-running Devin session) triages `auto`-labeled issues and dispatches
ephemeral workers; this directory holds the repo-side contract they act on;
`gate.mjs` is the deterministic admission check that decides whether a PR may
auto-merge. The gate never calls an LLM.

| File | Role |
| --- | --- |
| `eval.yaml` | Eval contract: metrics, extraction, weights, ratchet policy. An issue's "done" = all metrics pass and none regress below `baseline.json`. |
| `baseline.json` | Current ratchet baseline, updated by the conductor when a better score lands. |
| `policy.json` | Merge policy: allowed labels, max files/diff size, allowed and denied paths, allowed authors. |
| `gate.mjs` | Evaluates `policy.json` against a pull_request event + changed-file list. `node .conveyor/gate.mjs --self-check` runs the fixture cases with no network. |

## Who enforces what

- `gate.mjs` (workflow `conveyor-gate.yml`, required check `gate`) evaluates
  labels, author, diff size, and paths, then arms GitHub auto-merge.
- Green CI (`check`) and the `gate` check are required on `main` via branch
  protection — `require.ci_green` in policy.json documents that; it is enforced
  by GitHub, not by this script.
- Removing the `auto` label disarms auto-merge (the `disarm` job).
- Fork PRs are never gated (`head.repo` check in workflow and in `gate.mjs`).
