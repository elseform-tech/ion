/**
 * Drops the chat marker (`ION_CHAT`) the daemon may have inherited (started from a chat's tool call), so ion chief,
 * the project ions and the judge never carry a chat's marker: only a chat's run sets it (runs/manager.ts).
 */
export function dropInheritedMarkers(env: NodeJS.ProcessEnv = process.env): void {
  delete env.ION_CHAT;
}
