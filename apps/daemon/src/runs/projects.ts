import { DEFAULT_PROJECT, loadUserConfig, saveUserConfig } from "@ion/config";
import { UserError } from "../api/errors.js";
import { ensureDefaultProject } from "../workspace/index.js";

/** The project's own access mode, else the default from config.toml. */
export function accessFor(configFile: string, projectId: string): "auto" | "full" {
  const { config } = loadUserConfig(configFile);
  return config.projects.find((p) => p.id === projectId)?.access ?? config.access.default;
}

/** ion's `default` project, made the first time it's needed. */
export async function defaultProject(configFile: string): Promise<string> {
  const { config, error } = loadUserConfig(configFile);
  if (error) throw new UserError(`Fix your config first. ${error}`);
  const next = await ensureDefaultProject(config).catch((e: Error) => {
    throw new UserError(e.message);
  });
  if (next !== config) saveUserConfig(configFile, next);
  return DEFAULT_PROJECT;
}

/** A project's folder, or a refusal naming what's wrong. */
export function projectPath(configFile: string, projectId: string | null | undefined): string {
  if (!projectId) throw new UserError("Pick a project with -p <project>");
  const p = loadUserConfig(configFile).config.projects.find((x) => x.id === projectId);
  if (!p) throw new UserError(`Unknown project: ${projectId}`);
  return p.path;
}
