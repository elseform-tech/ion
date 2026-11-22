import { AUTO_APPROVAL, EV, type HookEvent, type IonEvent } from "@ion/schema";

/** Every ion event a hook can run on, in the order the Hooks tab shows them, with its plain name. */
export const CATALOG: readonly { event: HookEvent; name: string }[] = [
  { event: "tool.before", name: "Before a tool runs" },
  { event: EV.runStarted, name: "A chat starts" },
  { event: EV.runFinished, name: "A chat finishes" },
  { event: "run.failed", name: "A chat fails" },
  { event: EV.needRaised, name: "Something needs you" },
  { event: EV.needResolved, name: "You answered" },
  { event: EV.routineRan, name: "A routine ran" },
  { event: EV.chatArchived, name: "A chat is archived" },
  { event: EV.briefingPosted, name: "The briefing is posted" },
];

/** ion's own hook on "Before a tool runs": always there, never removed or turned off in Settings. */
export const BUILT_IN = {
  event: "tool.before" as HookEvent,
  id: AUTO_APPROVAL,
  name: "Auto-approval" as const,
};

/** A run's end as a hook event: done finishes, failed (or out of turns) fails; one you stopped is neither. */
function runEnd(e: IonEvent): HookEvent | null {
  const status = (e.data as { status?: unknown }).status;
  if (status === "done") return EV.runFinished;
  return status === "failed" || status === "capped" ? "run.failed" : null;
}

type Of = (e: IonEvent) => HookEvent | null;
const field = (e: IonEvent, k: string): unknown => (e.data as Record<string, unknown>)[k];
/** ion's own chats' runs aren't chats starting or ending. */
const chatRun =
  (of: Of): Of =>
  (e) =>
    // Only a chat's run: an ion's turn ("ion:…") or one kept off any chat (its agent's usage) isn't.
    !e.chatId || e.chatId.startsWith("ion:") ? null : of(e);

/** Each stored event a hook can run on, and what it is to your hooks (null: not this one). */
const OF: Partial<Record<string, Of>> = {
  [EV.runStarted]: chatRun(() => EV.runStarted),
  [EV.runFinished]: chatRun(runEnd),
  // A question held behind the same one already waiting isn't asked again.
  [EV.needRaised]: (e) => (field(e, "heldFor") ? null : EV.needRaised),
  [EV.needResolved]: (e) => (field(e, "by") === "you" ? EV.needResolved : null),
  [EV.routineRan]: (e) => (field(e, "skipped") ? null : EV.routineRan),
  [EV.chatArchived]: () => EV.chatArchived,
  [EV.briefingPosted]: () => EV.briefingPosted,
};

/** What a stored event is to your hooks, if anything. */
export const hookEventOf = (e: IonEvent): HookEvent | null => OF[e.type]?.(e) ?? null;
