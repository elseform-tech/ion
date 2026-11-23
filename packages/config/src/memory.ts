import type { UserConfig } from "./user-config.js";

type MemoryConfig = Pick<UserConfig, "memory" | "projects">;

/**
 * Memory's switches (the user, 2026-11-23: "a way to disable memory"). Your own memory follows the everywhere switch;
 * a project's follows it too, unless you set the project's own.
 */
export const youRemembered = (c: Pick<UserConfig, "memory">): boolean => c.memory.on !== false;

/** Whether this project's chats and its ion have memory (an unknown project follows everywhere). */
export const projectRemembered = (c: MemoryConfig, projectId: string): boolean =>
  c.projects.find((p) => p.id === projectId)?.memory ?? youRemembered(c);

/**
 * Turns memory on or off everywhere, or in one project; a project set like everywhere follows it again (so turning
 * everywhere off and on keeps a project you turned off).
 */
export function setMemory<C extends MemoryConfig>(c: C, on: boolean, projectId?: string): C {
  if (projectId === undefined) return { ...c, memory: { ...c.memory, on } };
  if (!c.projects.some((p) => p.id === projectId)) throw new Error(`Unknown project: ${projectId}`);
  const projects = c.projects.map((p) => {
    if (p.id !== projectId) return p;
    const rest = { ...p };
    delete rest.memory;
    return on === youRemembered(c) ? rest : { ...rest, memory: on };
  });
  return { ...c, projects };
}
