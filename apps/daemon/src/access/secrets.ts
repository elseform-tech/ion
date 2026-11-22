import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { ionPaths } from "@ion/config";
import { realish } from "../runs/policy.js";
import { agentConfigs } from "../runs/sandbox.js";
import { fold, under } from "./paths.js";

/**
 * ion's one list of secrets (review of 05d5c8b, 2026-11-22): your secret files and folders, agents' sign-in files, and
 * (for what ion reads itself) ion's own folders. Auto's rules and ion's own file reads both go by it.
 */

/** Your secrets under your home folder (folders end in "/"): never touched in Auto, whatever the judge says. */
const SECRETS = [
  ".ssh/",
  ".aws/",
  ".gnupg/",
  ".kube/",
  ".docker/",
  ".config/gh/",
  ".config/gcloud/",
  ".config/op/",
  ".password-store/",
  "Library/Keychains/",
  ".netrc",
  ".git-credentials",
  ".npmrc",
  ".pypirc",
];
/** Secret folders and files named anywhere in an action (any case) are denied: they never belong to a project. */
export const SECRET_NAMES = [
  // Agents' sign-in files (task review, 2026-11-21).
  ".codex/auth.json",
  ".claude/.credentials.json",
  "opencode/auth.json",
  ".ssh",
  ".aws",
  ".gnupg",
  ".kube",
  ".password-store",
  "keychains",
  ".config/gh",
  ".config/gcloud",
  ".config/op",
  ".docker/config",
  ".git-credentials",
  ".netrc",
  ".pypirc",
];
/** A sign-in file's name: credentials, tokens, auth*.json. */
const SIGN_IN = /credential|token|^auth.*\.json$/i;
/** Where agents keep their settings and sign-ins: every agent's config folder, and opencode's data folder. */
const agentHomes = (home: string) => [
  ...agentConfigs("", { ...process.env, HOME: home }),
  join(process.env.XDG_DATA_HOME || join(home, ".local/share"), "opencode"),
];
/**
 * An agent's sign-in file (task review, 2026-11-21): a secret for every chat, its own agent's too, refused like ~/.ssh.
 */
const signInFile = (p: string, home: string) =>
  SIGN_IN.test(basename(p)) && agentHomes(home).some((d) => under(fold(p), fold(realish(d))));

export const isSecret = (p: string, home: string) =>
  signInFile(p, home) ||
  SECRETS.some((s) => {
    const secret = fold(realish(join(home, s)));
    return s.endsWith("/") ? under(fold(p), secret) : fold(p) === secret;
  });

/** ion's own folders (its config's, data and cache folders), by your environment. */
function ionFoldersNow(env: NodeJS.ProcessEnv = process.env): string[] {
  const { configFile, dataDir } = ionPaths(env);
  return [
    dirname(configFile),
    dataDir,
    join(env.XDG_CACHE_HOME || join(env.HOME || homedir(), ".cache"), "ion"),
  ];
}

/** A secret, or one of ion's own folders: never read by ion through a link (what ion reads itself). */
export const isPrivate = (p: string, home: string): boolean =>
  isSecret(p, home) || ionFoldersNow().some((d) => under(fold(p), fold(realish(d))));
