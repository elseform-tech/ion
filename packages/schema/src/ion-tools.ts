/** The MCP tools ion gives a run's agent (server "ion"). */
export const ION_RUN_TOOLS = [
  "chat_history",
  "search_chats",
  "open_needs",
  "memory_list",
  "memory_write",
  "ask",
  "decisions",
  "report_outcome",
] as const;

/** The MCP tools ion gives an ion's own agent (server "ion"). */
export const ION_ION_TOOLS = [
  "projects",
  "search_chats",
  "chat_history",
  "open_needs",
  "memory_list",
  "memory_write",
  "decisions",
  "set_profile",
  "start_thread",
  "tools",
] as const;
