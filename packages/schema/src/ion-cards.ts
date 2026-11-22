import { z } from "zod";

/** What you picked with "/" (skills and commands) and "@" (servers), by name: shown as chips. */
export const PICKED = { skills: z.array(z.string()).optional(), mentions: z.array(z.string()).optional() };

/** The same schedule check as `parseWhen` (a routine's `when`). */
const WHEN_TEXT =
  /^(?:(?:daily|weekdays|sun|mon|tue|wed|thu|fri|sat) (?:[01]\d|2[0-3]):[0-5]\d|every (?:[1-9]|1\d|2[0-3])h)$/;

/**
 * What an ion's message can carry: threads it started, a suggestion, or a decision that keeps failing. ion chief's
 * own suggestions (Plan 11): a routine for something you keep asking for, or a chat of yours that stalled.
 */
export const IonCardSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("threads"),
    threads: z.array(z.object({ chatId: z.string(), projectId: z.string() })),
  }),
  z.object({
    kind: z.literal("suggest"),
    suggestionId: z.string(),
    question: z.string(),
    choice: z.string(),
  }),
  z.object({
    kind: z.literal("flag"),
    decisionId: z.string(),
    question: z.string(),
    choice: z.string(),
    failed: z.number().int().min(1),
  }),
  z.object({
    kind: z.literal("routine"),
    suggestionId: z.string(),
    projectId: z.string(),
    /** What makes it the same thing (your words, normalised): never suggested twice. */
    key: z.string().min(1),
    name: z.string().min(1),
    text: z.string().min(1),
    when: z.string().regex(WHEN_TEXT),
    /** When you asked (ISO), newest first, one per day. */
    dates: z.array(z.iso.datetime()).min(1),
  }),
  z.object({
    kind: z.literal("stalled"),
    suggestionId: z.string(),
    chatId: z.string(),
    projectId: z.string(),
    title: z.string(),
    /** The chat's last activity: it stalled from then. */
    since: z.iso.datetime(),
    /** Files changed in its worktree. */
    files: z.number().int().min(1),
  }),
]);
export type IonCard = z.infer<typeof IonCardSchema>;
