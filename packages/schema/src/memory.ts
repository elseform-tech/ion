import { z } from "zod";

/** What a memory file is about. */
export const MEMORY_TYPES = ["preference", "fact", "person", "todo", "reference"] as const;
export type MemoryType = (typeof MEMORY_TYPES)[number];

/** Who may see a memory file: chats (and ions), or ions only. */
export const MEMORY_SEE = ["chats", "ions"] as const;
export type MemorySee = (typeof MEMORY_SEE)[number];

/** The most text a memory file holds (and the most of an earlier text kept for undo), in bytes. */
export const MEMORY_TEXT_MAX = 8192;

/** A file's name in its folder: 1–60 lowercase letters, digits and "-". */
export const MEMORY_SLUG = /^[a-z0-9][a-z0-9-]{0,59}$/;

/** Where a memory file is, inside the memory folder: yours, or a project's. */
export const MEMORY_PATH = /^(?:you|projects\/[a-z0-9][a-z0-9._-]{0,63})\/[a-z0-9][a-z0-9-]{0,59}\.md$/;

const oneLine = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((s) => !/[\r\n]/.test(s), { message: "One line" });

/** A memory file's header, as ion reads it (keys it doesn't know are kept in the file, not here). */
export const MemoryHeaderSchema = z.object({
  name: oneLine(80),
  description: oneLine(160),
  type: z.enum(MEMORY_TYPES),
  see: z.enum(MEMORY_SEE),
  /** A to-do's state. */
  status: z.enum(["open", "done"]).optional(),
  /** A to-do's date (YYYY-MM-DD). */
  due: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  /** The old memory note this file was moved from, once. */
  from: z.string().min(1).max(40).optional(),
  /**
   * A preference a chat wrote, by its project's id: only that project's chats (and the ions) see it, until you keep
   * it for every project (security review, 2026-11-22).
   */
  suggested: z
    .string()
    .regex(/^[a-z0-9][a-z0-9._-]{0,63}$/)
    .optional(),
});
export type MemoryHeader = z.infer<typeof MemoryHeaderSchema>;

/** Who changed a memory file: you (in the app or an editor), a chat's run, or an ion. */
export const MemoryBySchema = z.union([
  z.literal("you"),
  z.object({ chatId: z.string(), runId: z.string() }),
  z.object({ ion: z.string() }),
]);
export type MemoryBy = z.infer<typeof MemoryBySchema>;

export const MemoryScopeSchema = z.union([z.literal("you"), z.object({ projectId: z.string() })]);
export type MemoryScope = z.infer<typeof MemoryScopeSchema>;

/** A file's text before a change, for undo (at most 8 KB of it). */
const Before = z.object({ hash: z.string(), text: z.string().max(MEMORY_TEXT_MAX) });

const memoryPath = z.string().regex(MEMORY_PATH);

/** A memory file written (made or changed): its header and hash; the text is in the file. */
const fileWritten = z.object({
  path: memoryPath,
  scope: MemoryScopeSchema,
  slug: z.string().regex(MEMORY_SLUG),
  header: MemoryHeaderSchema,
  hash: z.string().min(1),
  by: MemoryBySchema,
  before: Before.optional(),
});

/** A memory note from before memory was files (read for history and the move to files). */
const noteWritten = z.object({
  memoryId: z.string(),
  scope: MemoryScopeSchema,
  text: z.string().min(1).max(2000),
  source: z.union([z.literal("you"), z.object({ chatId: z.string(), runId: z.string() })]),
});

export const memoryEventSchemas = {
  "memory.written": z.union([fileWritten, noteWritten]),
  "memory.forgotten": z.union([
    z.object({ path: memoryPath, by: MemoryBySchema, before: Before }),
    z.object({ memoryId: z.string() }),
  ]),
};

/** A memory file as the app and the CLI list it. */
export type MemoryInfo = {
  memoryId: string;
  /** "you", or "project:<id>" for a project's files. */
  scope: string;
  name: string;
  description: string;
  type: MemoryType;
  see: MemorySee;
  /** A to-do's state and date. */
  status?: "open" | "done";
  due?: string;
  /** A chat's preference waiting for you to keep it: the project whose chat wrote it. */
  suggested?: string;
  text: string;
  /** "you", the chat it came from, or "ion:<id>". */
  source: string;
  writtenAt: string;
  /** The file can't be read now (its last good version is shown): one plain line. */
  problem?: string;
};

/** A memory file as read: its header, text and hash. */
export type MemoryFileInfo = {
  path: string;
  /** "you", or "project:<id>". */
  scope: string;
  name: string;
  description: string;
  type: MemoryType;
  see: MemorySee;
  status?: "open" | "done";
  due?: string;
  suggested?: string;
  text: string;
  hash: string;
};
