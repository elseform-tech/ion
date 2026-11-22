import {
  Blocks,
  BookOpen,
  Info,
  type LucideIcon,
  MessageCircleQuestion,
  PlugZap,
  Square,
  Webhook,
} from "@ion/design-system";
import type { ToolType } from "@ion/schema";
import { useState } from "react";
import { openTools } from "../goto.js";
import type { Item, Keep } from "./timeline.js";

/** A quiet line: an icon and one muted line in the conversation, never a banner. */
export const Quiet = ({ text, icon: Icon }: { text: string; icon: LucideIcon }) => (
  <div className="quiet">
    <Icon />
    {text}
  </div>
);

type Question = Extract<Item, { kind: "question" }>;

/** Why a question closed without your answer, in plain words. */
const ENDED = {
  stopped: "The chat stopped before you answered",
  archived: "The chat was archived before you answered",
  restarted: "ion restarted before you answered",
} as const;

/**
 * A question that's closed, where it was asked: the agent's question in one line (all of it on a click), then your
 * answer as your reply (where you sent it, when its message is in the chat) ("Always" when it reaches past the chat); one that ended without you says what happened.
 * One closed but not settled yet (held behind the same question elsewhere) shows nothing until it is.
 */
export function Answered({ q }: { q: Question }) {
  const [open, setOpen] = useState(false);
  const o = q.outcome;
  if (!o) return null;
  return (
    <>
      <div className="qa">
        <button
          className={open ? "qq open" : "qq"}
          type="button"
          aria-expanded={open}
          title={open ? undefined : q.question}
          onClick={() => setOpen(!open)}
        >
          <MessageCircleQuestion />
          {q.question}
        </button>
        {o.by === "stopped" && <Quiet text={ENDED[o.why ?? "stopped"]} icon={Square} />}
        {o.by === "ion" && <Quiet text={o.text} icon={Info} />}
      </div>
      {o.by === "you" && !q.replied && <Reply text={o.choice} always={o.always} />}
    </>
  );
}

/** Your answer as your reply, with "Always" (or "Remember", for a call ion stopped) when it reaches past the chat. */
export const Reply = ({ text, always }: { text: string; always: Keep | undefined }) => (
  <div className="u">
    {text}
    {always && <span className="chip">{always}</span>}
  </div>
);

const ICON: Record<ToolType, LucideIcon> = { mcp: PlugZap, skill: BookOpen, hook: Webhook };

/** A chat's agent added a tool: "github added, off", and a link to its row in Settings → Tools. */
export function Added({ item }: { item: Extract<Item, { kind: "added" }> }) {
  const Icon = ICON[item.tool] ?? PlugZap;
  return (
    <div className="quiet">
      <Icon />
      {`${item.name} added, off`}
      <button
        className="lnk"
        type="button"
        title="Open in Settings"
        onClick={() => openTools({ kind: item.tool, name: item.name })}
      >
        <Blocks />
        Tools
      </button>
    </div>
  );
}
