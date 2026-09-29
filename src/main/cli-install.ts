import { mkdir, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CliInstall } from "../shared/schema";

const SKILL_MD = `---
name: open-reedar
description: Query the user's local Reedar RSS reader library — list feeds with unread status, browse articles, read article text, and summarize articles. Use when the user asks about their feeds, unread news, or wants a summary of something in their reader.
---

# open-reedar CLI

The user's RSS library lives on this machine. The \`open-reedar\` CLI reads it directly (no app needs to be running).

## Commands

- \`open-reedar feeds [--json]\` — feeds with unread/starred counts; \`●\` means unread items exist
- \`open-reedar articles [--unread] [--starred] [--feed <text>] [--limit N] [--json]\` — articles, newest first
- \`open-reedar article <id> [--json]\` — full article text
- \`open-reedar summarize <id> [--agent codex|claude] [--question <text>]\` — summarize/answer using an installed agent CLI

\`--json\` prints JSON Lines (one object per line) on list commands; JSON is also the default whenever stdout is piped. Errors go to stderr, so stdout always carries parseable data.

IDs may be passed truncated as long as they are unique. Articles persist on disk at
\`~/Library/Application Support/Reedar/reader.json\`; override with \`REEDAR_STORE\`.

## Daily use

1. \`open-reedar feeds\` to see which feeds have unread items.
2. \`open-reedar articles --unread --feed <name>\` to pick what to read.
3. \`open-reedar summarize <id>\` for a digest, or \`open-reedar article <id>\` for the full text.
`;

function cliTarget(resourcesPath: string | undefined) {
  const bundled = resourcesPath ? join(resourcesPath, "bin", "open-reedar") : undefined;
  if (bundled && existsSync(bundled)) return `"${bundled}"`;
  const source = join(process.cwd(), "src", "cli", "open-reedar.ts");
  return `bun "${source}"`;
}

export async function installCli(options: { home?: string; resourcesPath?: string } = {}): Promise<CliInstall> {
  const home = options.home ?? process.env.REEDAR_HOME ?? homedir();
  const resourcesPath = options.resourcesPath ?? process.env.REEDAR_RESOURCES ?? process.resourcesPath;
  const binDirectory = join(home, ".local", "bin");
  await mkdir(binDirectory, { recursive: true });
  const bin = join(binDirectory, "open-reedar");
  await writeFile(bin, `#!/bin/sh\nexec ${cliTarget(resourcesPath)} "$@"\n`, { mode: 0o755 });
  const skills: string[] = [];
  for (const root of [".claude", ".codex", ".agents"]) {
    const directory = join(home, root, "skills", "open-reedar");
    await mkdir(directory, { recursive: true });
    const path = join(directory, "SKILL.md");
    await writeFile(path, SKILL_MD);
    skills.push(path);
    await rm(join(home, root, "skills", "reedar"), { recursive: true, force: true });
  }
  await rm(join(binDirectory, "reedar"), { force: true });
  return { bin, skills };
}
