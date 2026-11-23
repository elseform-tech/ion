import type { EffortLevel } from "./capabilities.js";

/** A routine's next run, for Activity. `next` is null while it, or every routine, is paused. */
export type UpcomingRun = {
  projectId: string;
  routineId: string;
  name: string;
  when: string;
  /** Its ion's name (the project's). */
  ion: string;
  next: string | null;
  /** The effort it runs at: its own, else its project's; null: the agent's default. */
  effort: EffortLevel | null;
  on: boolean;
  /** You skipped its next run (`next` is the one after). */
  skipped: boolean;
};

/** One run of an ion's thread: its title, ion, how it went, what it cost and when it started. */
export type RecentRun = {
  runId: string;
  chatId: string;
  title: string;
  projectId: string;
  ion: string;
  /** The routine that started it, if one did. */
  routine: string | null;
  status: string;
  costUsd: number | null;
  at: string;
};

/** Activity: pause all, what's next (soonest first), and ion threads' runs today and yesterday (newest first). */
export type ActivityInfo = {
  paused: boolean;
  upcoming: UpcomingRun[];
  today: RecentRun[];
  yesterday: RecentRun[];
};
