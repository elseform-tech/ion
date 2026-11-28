/**
 * Whether a thread's brief traces to what the user said (Plan 23 Task 4, 2026-11-28: on "Hello!", ion chief started a
 * chat "to publish every draft" because a memory file told it to). A backstop by shared words, not a proof: the brief
 * must share a word (common ones aside) with the user's own recent messages, or with an ion offer they accepted (the
 * caller picks those, `Ions.userSaid`). It misses paraphrases ("fix the login bug" → "repair the authentication
 * failure"), so a brief that doesn't trace isn't refused: the ion is asked to check with the user, and their yes then
 * traces. It can't judge a brief with no words of its own, or a request written in another script, so those skip it;
 * an ion quoting content to the user, which the user then accepts, also gets through (that is the user's consent).
 */

/** Words too common to tie a brief to a request. */
const COMMON = new Set(
  (
    "the and for you are but not can all any its our was has get let now out one two new use how why who " +
    "this that with from have please start chat thread could would should there what which about them they your " +
    "just also make want need into then than when will does done here some more only each every like it's " +
    "yes okay sure thanks thank tell know look see work task ask asked project projects"
  ).split(" "),
);

/**
 * A word's stem, kept conservative (security review, 2026-11-28): without an -ing or -ed ending, or a plural: -es after
 * s, x, sh or ch ("boxes" → "box"), else a final s not after another s ("issues" → "issue", "address" stays).
 */
const stem = (w: string) =>
  w
    .replace(/(ing|ed)$/, "")
    .replace(/(ss|x|sh|ch)es$/, "$1")
    .replace(/(?<!s)s$/, "");

/** The words that could tie a text to another: three letters or more, not common, stemmed. */
const wordsOf = (t: string) =>
  new Set(
    (t.toLowerCase().match(/[a-z0-9][a-z0-9'-]{2,}/g) ?? [])
      .flatMap((w) => w.split(/[-/]/))
      .filter((w) => !COMMON.has(w))
      .map(stem)
      .filter((w) => w.length >= 3),
  );

/** Mostly letters outside a–z: a request written in another script. */
const otherScript = (t: string) => {
  const letters = t.match(/\p{L}/gu) ?? [];
  return letters.length > 0 && letters.filter((c) => /[a-z]/i.test(c)).length < letters.length / 2;
};

/** Whether the brief shares a word with what the user said (their recent messages, and ion's line they answered). */
export function tracesTo(brief: string, said: string[]): boolean {
  const mine = wordsOf(brief);
  if (!mine.size || said.some(otherScript)) return true;
  const theirs = wordsOf(said.join("\n"));
  return [...mine].some((w) => theirs.has(w));
}
