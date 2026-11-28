/**
 * ion's `default` project is its own empty folder for chats in none of yours; a newcomer read "default" as "your
 * project" (Plan 21 Task 1, finding 12). It shows as "No project"; its id stays `default`.
 */
export const NO_PROJECT = "No project";

/** A project's name as shown: `default` as No project, else its name (or its id). */
export const projectName = (id: string, name?: string | null): string =>
  id === "default" ? NO_PROJECT : (name ?? id);

/** A project's own file, by its name: "shop's .mcp.json", or ".mcp.json in No project". */
export const projectsFile = (id: string, file: string): string =>
  id === "default" ? `${file} in ${NO_PROJECT}` : `${id}'s ${file}`;
