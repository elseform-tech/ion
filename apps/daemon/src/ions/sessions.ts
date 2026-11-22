import { type HarnessAdapter, ResumeFailed, type Session, type StartOpts } from "@ion/adapter-kit";
import { EV } from "@ion/schema";
import { DREAM_ION } from "../memory/dream-rules.js";
import type { Db, EventStore } from "../store/index.js";
import { ionsView } from "../views/ions.js";

/** An ion's session as kept between its turns: its agent, its native id, and the projects its tools saw. */
export type Kept = { harness: string; nativeId: string; projects: string[] };
type Deps = { db: Db; store: EventStore };

/**
 * The ion's session to resume: only on the agent it was made on, and while it may see the same projects (a project
 * kept from ion chief or removed is forgotten with the session that knew it).
 */
export function resumeOf(db: Db, ionId: string, harness: string, projects: string[]): string | undefined {
  // Each dream starts afresh, and keeps no session.
  if (ionId === DREAM_ION) return undefined;
  const s = ionsView.session(db, ionId);
  const same = s?.projects?.join("\n") === projects.join("\n");
  return s?.harness === harness && same ? s.nativeId : undefined;
}

/** A session the agent can't resume (gone, expired) is started anew. */
export async function startSession(
  adapter: HarnessAdapter,
  opts: StartOpts,
  resume: string | undefined,
): Promise<{ session: Session; resumed: boolean }> {
  if (!resume) return { session: await adapter.start(opts), resumed: false };
  try {
    return { session: await adapter.start({ ...opts, resume }), resumed: true };
  } catch (e) {
    if (e instanceof ResumeFailed) return { session: await adapter.start(opts), resumed: false };
    throw e;
  }
}

/** Forgets the ion's session (when it has one), so its next turn starts a fresh one. */
export function forgetSession(d: Deps, ionId: string): void {
  if (!ionsView.session(d.db, ionId)) return;
  d.store.append({
    chatId: `ion:${ionId}`,
    runId: null,
    origin: "daemon",
    type: EV.ionSession,
    data: { ionId, harness: null, nativeId: null },
  });
}

/** Records the ion's session when it's new (another agent, a session it couldn't resume, other projects). */
export function keepSession(d: Deps, ionId: string, k: Kept): void {
  if (ionId === DREAM_ION) return;
  const s = ionsView.session(d.db, ionId);
  const same = s?.projects?.join("\n") === k.projects.join("\n");
  if (s?.harness === k.harness && s.nativeId === k.nativeId && same) return;
  d.store.append({
    chatId: `ion:${ionId}`,
    runId: null,
    origin: "daemon",
    type: EV.ionSession,
    data: { ionId, ...k },
  });
}
