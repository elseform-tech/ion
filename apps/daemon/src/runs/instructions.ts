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
  "Look in ion's memory (its index is at the top of your first message; memory_search, memory_read) before asking",
  "the user something you may already know.",
  "Keep one topic per memory file; update a file (memory_read, then memory_write with its hash as expect) rather than adding a near-copy.",
  "With memory_write, write what the next chat in this project should know.",
  "When you need several read-only lookups, chain them into one command with && rather than one call each.",
  "To add an MCP server, skill or hook, use ion's own commands, never an agent's config: `ion mcp search <name>`",
  "shows the official registry's install command, keys and source (copy them, never guess), then",
  "`ion mcp add <name> --command <cmd> --arg <arg>… | --url <url>` with `--env 'NAME=${NAME}'` or",
  "`--header 'Authorization: Bearer ${NAME}'` for keys (single quotes, so your shell leaves ${NAME} alone) and",
  "`--from <registry id>`; likewise `ion skills add` and `ion hooks add` (see `ion <kind> --help`). Never put a key",
  "in a command. What you add starts off: the user turns it on, and signs in, in ion's Settings → Tools.",
].join(" ");
