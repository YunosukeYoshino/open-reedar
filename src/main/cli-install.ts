import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CliInstall } from "../shared/schema";

const SKILL_MD = `---
name: reedar
description: Query the user's local Reedar RSS reader library — list feeds with unread status, browse articles, read article text, and summarize articles. Use when the user asks about their feeds, unread news, or wants a summary of something in their reader.
---

# Reedar CLI

The user's RSS library lives on this machine. The \`reedar\` CLI reads it directly (no app needs to be running).

## Commands

- \`reedar feeds [--json]\` — feeds with unread/starred counts; \`●\` means unread items exist
- \`reedar articles [--unread] [--starred] [--feed <text>] [--limit N] [--json]\` — articles, newest first
- \`reedar article <id> [--json]\` — full article text
- \`reedar summarize <id> [--agent codex|claude] [--question <text>]\` — summarize/answer using an installed agent CLI

\`--json\` prints JSON Lines (one object per line) on list commands; JSON is also the default whenever stdout is piped. Errors go to stderr, so stdout always carries parseable data.

IDs may be passed truncated as long as they are unique. Articles persist on disk at
\`~/Library/Application Support/Reedar/reader.json\`; override with \`REEDAR_STORE\`.

## Daily use

1. \`reedar feeds\` to see which feeds have unread items.
2. \`reedar articles --unread --feed <name>\` to pick what to read.
3. \`reedar summarize <id>\` for a digest, or \`reedar article <id>\` for the full text.
`;

function cliTarget(resourcesPath: string | undefined) {
  const bundled = resourcesPath ? join(resourcesPath, "bin", "reedar") : undefined;
  if (bundled && existsSync(bundled)) return `"${bundled}"`;
  const source = join(process.cwd(), "src", "cli", "reedar.ts");
  return `bun "${source}"`;
}

export async function installCli(options: { home?: string; resourcesPath?: string } = {}): Promise<CliInstall> {
  const home = options.home ?? process.env.REEDAR_HOME ?? homedir();
  const resourcesPath = options.resourcesPath ?? process.env.REEDAR_RESOURCES ?? process.resourcesPath;
  const binDirectory = join(home, ".local", "bin");
  await mkdir(binDirectory, { recursive: true });
  const bin = join(binDirectory, "reedar");
  await writeFile(bin, `#!/bin/sh\nexec ${cliTarget(resourcesPath)} "$@"\n`, { mode: 0o755 });
  const skills: string[] = [];
  for (const root of [".claude", ".codex", ".agents"]) {
    const directory = join(home, root, "skills", "reedar");
    await mkdir(directory, { recursive: true });
    const path = join(directory, "SKILL.md");
    await writeFile(path, SKILL_MD);
    skills.push(path);
  }
  return { bin, skills };
}
