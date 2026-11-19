const REPORT_MAX = 1200;

/** Without the ion's agent: the agent's own reply when it finished, else what happened, in plain words. */
export function plainReport(title: string, status: string, reply: string): string {
  if (status === "done") return reply.trim().slice(0, REPORT_MAX) || `“${title}” is done.`;
  if (status === "interrupted") return `“${title}” was stopped.`;
  if (status === "capped") return `“${title}” hit its limit before it finished.`;
  return `I couldn't finish “${title}”.`;
}
