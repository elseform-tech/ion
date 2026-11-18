import type { HarnessEntry } from "../adapters/registry.js";
import { UserError } from "../api/errors.js";

const TITLE_MAX = 60;

/** A chat's title: its first message's first line; a long one is cut at a word and marked "…". */
export function titleOf(text: string): string {
  const line = text.trim().split("\n")[0]!;
  if (line.length <= TITLE_MAX) return line;
  const cut = line.slice(0, TITLE_MAX - 1);
  const word = cut.lastIndexOf(" ");
  return `${(word > TITLE_MAX / 2 ? cut.slice(0, word) : cut).trimEnd()}…`;
}

/** How long an agent that was ready counts as ready without asking again. A failed check is asked again. */
const READY_FOR_MS = 2 * 60_000;

/**
 * Whether an agent can take a message: installed, signed in, and (when one is named) the model is one it lists.
 * Asking its CLI costs seconds, so a check that passed holds for a while.
 */
export class Readiness {
  private readonly until = new Map<string, number>();

  async check(h: HarnessEntry, model?: string): Promise<void> {
    const key = `${h.label}\u0000${model ?? ""}`;
    if ((this.until.get(key) ?? 0) > Date.now()) return;
    await ask(h, model);
    this.until.set(key, Date.now() + READY_FOR_MS);
  }
}

async function ask(h: HarnessEntry, model?: string): Promise<void> {
  if (!(await h.adapter.detect()).installed) throw new UserError(`${h.label} isn't installed`);
  if (!(await h.adapter.auth.status()).signedIn)
    throw new UserError(`${h.label} isn't signed in. Run: ${h.loginHint}`);
  // A live model list is the harness's own: a name it doesn't list won't run.
  if (!model) return;
  const caps = await h.adapter.capabilities();
  if (caps.modelsLive && !caps.models.some((x) => x.id === model))
    throw new UserError(`Unknown model for ${h.label}: ${model}`);
}
