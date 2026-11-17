import { homedir } from "node:os";
import { join } from "node:path";

/** Where ion keeps its config file and data. ION_HOME overrides everything (tests use it). */
export function ionPaths(env: NodeJS.ProcessEnv = process.env): { configFile: string; dataDir: string } {
  if (env.ION_HOME)
    return { configFile: join(env.ION_HOME, "config.toml"), dataDir: join(env.ION_HOME, "data") };
  const home = env.HOME ?? homedir();
  return {
    configFile: join(env.XDG_CONFIG_HOME ?? join(home, ".config"), "ion", "config.toml"),
    dataDir: join(env.XDG_DATA_HOME ?? join(home, ".local", "share"), "ion"),
  };
}
