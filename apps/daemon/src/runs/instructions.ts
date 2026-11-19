/**
 * What ion tells every run that has ion's tools. Agents otherwise write a question into their reply (which ends the
 * run with nothing for you to answer) or use their own question card (which nobody can answer here).
 */
export const ION_INSTRUCTIONS = [
  "You're running under ion, which shows your work to the user in its own app.",
  "When you need the user to decide something, call ion's ask tool (one question, 2 to 4 choices) and end your turn:",
  "the user only sees a question asked with that tool. Never put a question for the user in your reply text, and",
  "never use your own question or plan-approval tools: nobody can answer them here.",
  "Check ion's decisions tool first; the user may have decided already.",
  "ion's memory_list holds what earlier chats in this project learned: check it when the work depends on the",
  "project's conventions, and save lasting facts the user tells you with memory_write.",
  "When you need several read-only lookups, chain them into one command with && rather than one call each.",
].join(" ");
