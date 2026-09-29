import { z } from "zod";

export const agentSchema = z.enum(["claude", "codex", "antigravity"]);
export type Agent = z.infer<typeof agentSchema>;
export const codexModel = "gpt-6-luna";

export const folderSchema = z.object({ id: z.string(), name: z.string() });
export const feedSchema = z.object({
  id: z.string(),
  url: z.string(),
  title: z.string(),
  siteUrl: z.string(),
  folderId: z.string().nullable(),
  updatedAt: z.string().nullable(),
  error: z.string().nullable(),
  removedAt: z.string().optional(),
});
export type Feed = z.infer<typeof feedSchema>;

export const articleSchema = z.object({
  id: z.string(),
  feedId: z.string(),
  title: z.string(),
  url: z.string(),
  author: z.string(),
  publishedAt: z.string(),
  receivedAt: z.string(),
  html: z.string(),
  text: z.string(),
  excerpt: z.string(),
  imageUrl: z.string().nullable(),
  read: z.boolean(),
  starred: z.boolean(),
  readerHtml: z.string().optional(),
  readerText: z.string().optional(),
});
export type Article = z.infer<typeof articleSchema>;

export const runStateSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("running"), phase: z.enum(["fetching", "answering"]).optional() }),
  z.object({ status: z.literal("waiting"), reason: z.string() }),
  z.object({ status: z.literal("completed") }),
  z.object({ status: z.literal("failed"), error: z.string() }),
  z.object({ status: z.literal("cancelled") }),
]);
export type RunState = z.infer<typeof runStateSchema>;

export const messageSchema = z.discriminatedUnion("role", [
  z.object({ id: z.string(), role: z.literal("user"), text: z.string(), createdAt: z.string() }),
  z.object({
    id: z.string(), role: z.literal("assistant"), text: z.string(), createdAt: z.string(),
    state: runStateSchema,
    model: z.string().optional(),
    purpose: z.enum(["chat", "summary"]).optional(),
    sourceOrigin: z.enum(["feed", "web"]).optional(),
  }),
]);
export type Message = z.infer<typeof messageSchema>;

export const sourceSchema = z.object({
  title: z.string(), url: z.string(), text: z.string(), capturedAt: z.string(),
  origin: z.enum(["feed", "web"]).optional(), fetchError: z.string().optional(),
});

export const conversationSchema = z.object({
  id: z.string(),
  articleId: z.string(),
  agent: agentSchema,
  source: sourceSchema,
  previousSource: sourceSchema.optional(),
  messages: z.array(messageSchema),
});
export type Conversation = z.infer<typeof conversationSchema>;

export const languageSchema = z.enum(["en", "ja"]);
export type Language = z.infer<typeof languageSchema>;

export const stateSchema = z.object({
  version: z.literal(1),
  folders: z.array(folderSchema),
  feeds: z.array(feedSchema),
  articles: z.array(articleSchema),
  conversations: z.array(conversationSchema),
  language: languageSchema.default("en"),
});
export type ReaderState = z.infer<typeof stateSchema>;

export const connectionSchema = z.object({
  agent: agentSchema,
  installed: z.boolean(),
  status: z.enum(["checking", "ready", "authentication", "unavailable", "unsupported", "error"]),
  detail: z.string(),
});
export type Connection = z.infer<typeof connectionSchema>;

export const opmlImportSchema = z.object({
  status: z.enum(["running", "completed", "cancelled", "failed"]),
  total: z.number().int().nonnegative(),
  results: z.array(z.object({ id: z.string(), title: z.string(), url: z.string(), status: z.enum(["imported", "skipped", "failed"]), detail: z.string() })),
  error: z.string().optional(),
});
export type OpmlImport = z.infer<typeof opmlImportSchema>;

export const opmlPreviewSchema = z.object({
  entries: z.array(z.object({
    url: z.string(), title: z.string(), folderName: z.string().nullable(),
    resolution: z.enum(["new", "duplicate", "restorable", "invalid", "inFileDuplicate"]),
    detail: z.string().optional(),
  })),
  missingFeeds: z.array(z.object({ id: z.string(), title: z.string(), url: z.string(), folderName: z.string().nullable() })),
});
export type OpmlPreview = z.infer<typeof opmlPreviewSchema>;

export const organizeJobSchema = z.object({
  scope: z.enum(["library", "opml"]),
  agent: agentSchema,
  status: z.enum(["running", "completed", "failed"]),
  startedAt: z.string(),
  detail: z.string().optional(),
  plan: z.object({
    moves: z.array(z.object({ feedId: z.string(), title: z.string(), folderName: z.string(), newFolder: z.boolean() })),
    assignments: z.array(z.object({ url: z.string(), title: z.string(), folderName: z.string() })),
  }).optional(),
});
export type OrganizeJob = z.infer<typeof organizeJobSchema>;

export const cliInstallSchema = z.object({ bin: z.string(), skills: z.array(z.string()) });
export type CliInstall = z.infer<typeof cliInstallSchema>;

export const snapshotSchema = z.object({
  state: stateSchema,
  connections: z.array(connectionSchema),
  refreshing: z.boolean(),
  opmlImport: opmlImportSchema.nullable().optional(),
  opmlPreview: opmlPreviewSchema.nullable().optional(),
  organize: organizeJobSchema.nullable().optional(),
  cliInstall: cliInstallSchema.nullable().optional(),
});
export type Snapshot = z.infer<typeof snapshotSchema>;

export const updateSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("snapshot"), snapshot: snapshotSchema }),
  z.object({ type: z.literal("conversation"), conversation: conversationSchema }),
]);
export type Update = z.infer<typeof updateSchema>;

export const actionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("feed.add"), url: z.string().trim().url().max(2048), folderId: z.string().nullable() }),
  z.object({ type: z.literal("feed.remove"), id: z.string() }),
  z.object({ type: z.literal("feed.restore"), id: z.string() }),
  z.object({ type: z.literal("feed.move"), id: z.string(), folderId: z.string().nullable() }),
  z.object({ type: z.literal("folder.save"), id: z.string().nullable(), name: z.string().trim().min(1).max(60) }),
  z.object({ type: z.literal("folder.remove"), id: z.string() }),
  z.object({ type: z.literal("article.read"), id: z.string(), read: z.boolean() }),
  z.object({ type: z.literal("article.fetchText"), id: z.string() }),
  z.object({ type: z.literal("article.star"), id: z.string(), starred: z.boolean() }),
  z.object({ type: z.literal("opml.import"), xml: z.string().min(1).max(262_144), urls: z.array(z.string()).max(200).optional(), folders: z.record(z.string(), z.string().trim().min(1).max(60)).optional() }),
  z.object({ type: z.literal("opml.preview"), xml: z.string().min(1).max(262_144) }),
  z.object({ type: z.literal("opml.previewClear") }),
  z.object({ type: z.literal("opml.stop") }),
  z.object({ type: z.literal("refresh") }),
  z.object({ type: z.literal("connections.refresh") }),
  z.object({ type: z.literal("organize.propose"), agent: agentSchema, scope: z.enum(["library", "opml"]) }),
  z.object({
    type: z.literal("organize.apply"),
    moves: z.array(z.object({ feedId: z.string(), folderName: z.string().trim().min(1).max(60) })).max(200).optional(),
    assignments: z.array(z.object({ url: z.string().max(2048), folderName: z.string().trim().min(1).max(60) })).max(200).optional(),
  }),
  z.object({ type: z.literal("organize.cancel") }),
  z.object({ type: z.literal("organize.clear") }),
  z.object({ type: z.literal("cli.install") }),
  z.object({ type: z.literal("chat.send"), articleId: z.string(), agent: agentSchema, text: z.string().trim().min(1).max(4000) }),
  z.object({ type: z.literal("chat.summarize"), articleId: z.string(), agent: agentSchema }),
  z.object({ type: z.literal("chat.stop"), conversationId: z.string() }),
  z.object({ type: z.literal("app.setLanguage"), language: languageSchema }),
]);
export type Action = z.infer<typeof actionSchema>;
