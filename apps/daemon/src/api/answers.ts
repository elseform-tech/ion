import { loadUserConfig } from "@ion/config";
import { agentLabel, byPreference } from "../adapters/registry.js";
import { createMatcher, Decisions } from "../decisions/index.js";
import type { IonQuestions } from "../ions/questions.js";
import type { NeedsService } from "../needs/index.js";
import type { RunManager } from "../runs/manager.js";
import { Handoffs } from "../runs/limit-handoff.js";
import { Waits } from "../scheduler/index.js";
import type { Db, EventStore } from "../store/index.js";
import { diffOfChat, harnessInfos } from "./commands.js";
import type { HarnessInfos } from "./harness-infos.js";
import { orderIn } from "./routing.js";

/** An answer's message as ask arguments: its chat, its text, and the chat's agent. */
export const followAsk = (chatId: string, m: { harness: string | null; text: string }) => ({
  chatId,
  text: m.text,
  ...(m.harness ? { harness: m.harness } : {}),
});

/**
 * How long ion's limit question waits on a first sign-in check still going (only just after ion starts). Live,
 * 2026-11-23: opencode's first check took 4 s alone and over 5 s while every agent was checked at once, so the question
 * offered the next agent; 8 s covers it. `ion ask` stays longer than this for the question.
 */
const READY_WAIT_MS = 8000;

/**
 * The agents signed in, for ion's limit question: what's known, waiting for a first sign-in check still going (just
 * after ion starts) READY_WAIT_MS at most, so an agent isn't skipped for being slow to answer.
 */
export const readyForLimit = async (infos: Pick<HarnessInfos, "soon">): Promise<string[]> =>
  (await infos.soon(READY_WAIT_MS)).filter((h) => h.installed && h.signedIn).map((h) => h.id);

type Deps = { store: EventStore; db: Db; needs: NeedsService; runs: RunManager; configFile: string };

/**
 * When a chat's agent hits its limit: ion's question, the run on another agent (or the wait) your answer starts.
 * The agents offered are the ones signed in now, in your agent order; Settings says whether ion asks; ion's message to the agent is hidden in the
 * chat, which shows its one line.
 */
function limitHandoffs(d: Deps): Handoffs {
  return new Handoffs({
    ...{ store: d.store, db: d.db, needs: d.needs, label: agentLabel, waits: new Waits() },
    ready: async () => byPreference(await readyForLimit(harnessInfos), orderIn(d.configFile)),
    onLimit: () => loadUserConfig(d.configFile).config.routing.onLimit,
    start: async (a, o) =>
      (
        await d.runs.ask(a, {
          request: o.request,
          handoff: true,
          ...(o.answers ? { answers: o.answers } : {}),
        })
      ).runId,
    changed: async (chatId) => (await diffOfChat(d, chatId)).files,
  });
}

/**
 * What answers questions in chats: your answer to an agent's goes back into its chat as the next message, on the
 * chat's agent (Decisions); ion's own when a chat's agent hit its limit continues on another or waits (Handoffs).
 */
export function answersOf(d: Deps & { quick: Parameters<typeof createMatcher>[0]; ion: IonQuestions }): {
  decisions: Decisions;
  handoffs: Handoffs;
} {
  const { runs } = d;
  const decisions = new Decisions({
    ...{ store: d.store, db: d.db, needs: d.needs },
    match: createMatcher(d.quick),
    ion: d.ion,
    followUp: async (chatId, m) =>
      (await runs.ask(followAsk(chatId, m), { request: m.request, shown: m.shown, answers: m.answers }))
        .runId,
    requestOf: (runId) => runs.requestOf(runId),
  });
  return { decisions, handoffs: limitHandoffs(d) };
}
