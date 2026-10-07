#!/usr/bin/env node
// conveyor auto-merge gate — deterministic admission check for auto-labeled PRs.
// Reads the pull_request event payload + policy.json, prints a verdict JSON,
// exits 0 when the PR may be armed for auto-merge, 1 otherwise.
// Usage: node .conveyor/gate.mjs [--self-check]
//   CI:   runs inside conveyor-gate.yml with GITHUB_EVENT_PATH + GH_TOKEN set.
//   Local: node .conveyor/gate.mjs --self-check   (no network, fixture cases)

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const POLICY_PATH = join(HERE, "policy.json");

// --- glob matching: ** = any chars incl /, **/ = zero or more dirs, * = non-/ chars ---
const globToRegExp = (glob) => {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") {
      if (glob[i + 2] === "/") {
        re += "(?:.*/)?";
        i += 2;
      } else {
        re += ".*";
        i += 1;
      }
    } else if (c === "*") {
      re += "[^/]*";
    } else if (c === "?") {
      re += "[^/]";
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${re}$`);
};

const evaluate = (policy, pr, files) => {
  const reasons = [];
  const labels = pr.labels.map((l) => l.name ?? l);
  if (!policy.allow.labels.some((l) => labels.includes(l))) {
    reasons.push(`missing label: none of ${policy.allow.labels.join(", ")} on ${labels.join(",") || "(none)"}`);
  }
  if (policy.require.author_in.length > 0 && !policy.require.author_in.includes(pr.author)) {
    reasons.push(`author ${pr.author} not in require.author_in`);
  }
  if (pr.fork) reasons.push("head repo is a fork");
  if (pr.changed_files > policy.allow.max_changed_files) {
    reasons.push(`changed_files ${pr.changed_files} > ${policy.allow.max_changed_files}`);
  }
  const diffLines = pr.additions + pr.deletions;
  if (diffLines > policy.allow.max_diff_lines) {
    reasons.push(`diff lines ${diffLines} > ${policy.allow.max_diff_lines}`);
  }
  const allowRes = policy.allow.paths.map(globToRegExp);
  const denyRes = policy.deny.paths.map(globToRegExp);
  for (const file of files) {
    if (denyRes.some((re) => re.test(file))) {
      reasons.push(`denied path: ${file}`);
    } else if (!allowRes.some((re) => re.test(file))) {
      reasons.push(`not in allow.paths: ${file}`);
    }
  }
  return { verdict: reasons.length === 0 ? policy.verdict : "escalate", reasons };
};

const fetchPrFiles = (repo, number) => {
  const out = execFileSync(
    "gh",
    ["api", `repos/${repo}/pulls/${number}/files`, "--paginate", "--jq", ".[].filename"],
    { env: { ...process.env }, encoding: "utf8" },
  );
  return out.split("\n").filter(Boolean);
};

const main = () => {
  const policy = JSON.parse(readFileSync(POLICY_PATH, "utf8"));
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
  const pr = event.pull_request;
  if (!pr) {
    console.log("not a pull_request event — nothing to gate");
    return;
  }
  const input = {
    labels: pr.labels,
    author: pr.user.login,
    fork: pr.head.repo.fork,
    changed_files: pr.changed_files,
    additions: pr.additions,
    deletions: pr.deletions,
  };
  const files = process.env.CONVEYOR_FILES
    ? process.env.CONVEYOR_FILES.split("\n").filter(Boolean)
    : fetchPrFiles(event.repository.full_name, pr.number);
  const result = evaluate(policy, input, files);
  console.log(JSON.stringify({ pr: pr.number, files: files.length, ...result }, null, 2));
  if (result.verdict !== "arm_auto_merge") {
    console.error(`gate: ${result.reasons.join("; ")}`);
    process.exit(1);
  }
};

const selfCheck = () => {
  const policy = JSON.parse(readFileSync(POLICY_PATH, "utf8"));
  const bot = policy.require.author_in[0];
  const base = {
    labels: [{ name: "auto" }],
    author: bot,
    fork: false,
    changed_files: 2,
    additions: 30,
    deletions: 20,
  };
  const cases = [
    { name: "eligible small PR", pr: base, files: ["src/ui/App.tsx", "tests/app.test.ts"], want: "arm_auto_merge" },
    { name: "denied path package.json", pr: { ...base, changed_files: 1 }, files: ["package.json"], want: "escalate" },
    { name: "denied path workflow", pr: { ...base, changed_files: 1 }, files: [".github/workflows/ci.yml"], want: "escalate" },
    { name: "denied path agents", pr: { ...base, changed_files: 1 }, files: ["src/main/agents/runner.ts"], want: "escalate" },
    { name: "root migrations dir", pr: { ...base, changed_files: 1 }, files: ["migrations/001.sql"], want: "escalate" },
    { name: "too many files", pr: { ...base, changed_files: 11 }, files: Array.from({ length: 11 }, (_, i) => `src/f${i}.ts`), want: "escalate" },
    { name: "diff too large", pr: { ...base, additions: 500, deletions: 100 }, files: ["src/big.ts"], want: "escalate" },
    { name: "no auto label", pr: { ...base, labels: [{ name: "bug" }] }, files: ["src/x.ts"], want: "escalate" },
    { name: "fork head", pr: { ...base, fork: true }, files: ["src/x.ts"], want: "escalate" },
    { name: "unknown author", pr: { ...base, author: "random-user" }, files: ["src/x.ts"], want: "escalate" },
    { name: "markdown only", pr: { ...base, changed_files: 1 }, files: ["docs/notes.md"], want: "arm_auto_merge" },
  ];
  let failed = 0;
  for (const c of cases) {
    const got = evaluate(policy, c.pr, c.files).verdict;
    const ok = got === c.want;
    if (!ok) failed++;
    console.log(`${ok ? "ok" : "FAIL"} ${c.name} → ${got} (want ${c.want})`);
  }
  if (failed) process.exit(1);
  console.log("self-check passed");
};

process.argv.includes("--self-check") ? selfCheck() : main();
