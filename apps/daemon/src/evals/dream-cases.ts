/**
 * The dream's eval cases (the user, 2026-11-22: ion tidies memory overnight, "Apply everything"): each seeds memory
 * files (as ion chief wrote them, over a day ago in effect: none is a recent edit of yours) and the last week's chats,
 * runs one dream, and scores the memory folder after. Run by `dream.test.ts` on each real agent.
 *
 * Every case also holds valid facts no chat contradicts: forgetting or rewriting one is a failure (`validBroken`),
 * and must be 0 on every agent.
 */

import { h, type Seed, shop, you } from "./memory-seeds.js";

export const DREAM_MEASURES = ["stale", "merge", "person", "todo", "valid"] as const;
type DreamMeasure = (typeof DREAM_MEASURES)[number];

/** A chat of the last week: its title, project, your last message and the agent's last reply. */
type DreamChat = { title: string; projectId: string | null; you: string; agent: string };

type Expect = {
  /** Some file says this afterwards, and no file says `lacks` (a stale fact caught). */
  fixed?: { has?: RegExp; lacks: RegExp };
  /** One of these two files is left, and it says each of `has` (merged without losing details). */
  merged?: { paths: [string, string]; has: RegExp[] };
  /** This file is exactly as seeded (a person file). */
  same?: string;
  /** This to-do is still open. */
  open?: string;
};

export type DreamCase = {
  id: string;
  measure: DreamMeasure;
  seeds: Seed[];
  /** Files no chat contradicts: each must be exactly as seeded afterwards. */
  valid: string[];
  chats: DreamChat[];
  expect: Expect;
};

const STAGING: Seed = {
  path: shop("staging-port"),
  header: h("Staging port", "Where the shop's staging server listens", "reference"),
  text: "The shop's staging server listens on port 8443.",
};
const TESTS: Seed = {
  path: shop("test-runner"),
  header: h("Test runner", "How the shop's tests run", "fact"),
  text: "The shop's tests run with pytest (`pytest -q`).",
};
const ENGLISH: Seed = {
  path: you("british-english"),
  header: h("British English", "How the user wants replies spelt", "preference", { see: "chats" }),
  text: "Write replies in British English.",
};
const CSS_CHAT: DreamChat = {
  title: "Button colours",
  projectId: "shop",
  you: "Make the checkout button green.",
  agent: "Done: the checkout button is now green (#2e7d32).",
};

export const DREAM_CASES: DreamCase[] = [
  {
    id: "dream-stale-pnpm",
    measure: "stale",
    seeds: [
      {
        path: shop("package-manager"),
        header: h("Package manager", "How the shop installs packages", "fact"),
        text: "The shop installs packages with npm (`npm install`).",
      },
      STAGING,
    ],
    valid: [STAGING.path],
    chats: [
      {
        title: "Switch to pnpm",
        projectId: "shop",
        you: "We moved the shop from npm to pnpm this week; use pnpm install from now on.",
        agent: "Done: the shop now uses pnpm (pnpm-lock.yaml added, package-lock.json removed).",
      },
    ],
    expect: { fixed: { has: /pnpm/, lacks: /installs packages with npm/ } },
  },
  {
    id: "dream-stale-db-host",
    measure: "stale",
    seeds: [
      {
        path: shop("database-host"),
        header: h("Database host", "Where the shop's database runs", "fact"),
        text: "The shop's database runs on db-old.internal.",
      },
      TESTS,
    ],
    valid: [TESTS.path],
    chats: [
      {
        title: "Database move",
        projectId: "shop",
        you: "The shop's database moved from db-old.internal to db2.internal yesterday; db-old is switched off.",
        agent: "Updated the config: the shop now connects to db2.internal.",
      },
    ],
    expect: { fixed: { has: /db2\.internal/, lacks: /runs on db-old\.internal/ } },
  },
  {
    id: "dream-merge-deploy",
    measure: "merge",
    seeds: [
      {
        path: shop("deploy-steps"),
        header: h("Deploy steps", "How the shop deploys", "fact"),
        text: "The shop deploys from the main branch.",
      },
      {
        path: shop("deploy-notes"),
        header: h("Deploy notes", "Notes on deploying the shop", "fact"),
        text: "Deploying the shop needs the VPN switched on.",
      },
      STAGING,
    ],
    valid: [STAGING.path],
    chats: [CSS_CHAT],
    expect: { merged: { paths: [shop("deploy-steps"), shop("deploy-notes")], has: [/main/, /VPN/] } },
  },
  {
    id: "dream-person-untouched",
    measure: "person",
    seeds: [
      {
        path: you("priya"),
        header: h("Priya", "The user's accountant", "person"),
        text: "Priya is the user's accountant. She lives in Leeds.",
      },
      ENGLISH,
    ],
    valid: [ENGLISH.path],
    chats: [
      {
        title: "Tax papers",
        projectId: null,
        you: "Priya told me she moved to Manchester last month.",
        agent: "Noted.",
      },
    ],
    expect: { same: you("priya") },
  },
  {
    id: "dream-todo-open",
    measure: "todo",
    seeds: [
      {
        path: you("renew-the-passport"),
        header: h("Renew the passport", "Renew the passport", "todo", { status: "open" }),
        text: "Renew the passport before the trip.",
      },
      ENGLISH,
    ],
    valid: [ENGLISH.path],
    chats: [
      {
        title: "Passport",
        projectId: null,
        you: "I renewed my passport yesterday, that's done.",
        agent: "Great, good to hear.",
      },
    ],
    expect: { open: you("renew-the-passport") },
  },
  {
    id: "dream-valid-old",
    measure: "valid",
    seeds: [
      STAGING,
      TESTS,
      ENGLISH,
      {
        path: shop("cart-rounding"),
        header: h("Cart rounding", "How cart totals round", "fact"),
        text: "Cart totals round to 2 decimal places.",
      },
      {
        path: shop("release-freeze"),
        header: h("Release freeze", "When the year-end release freeze starts", "fact"),
        text: "The year-end release freeze starts on 3 December. Only fixes go in after that.",
      },
    ],
    valid: [STAGING.path, TESTS.path, ENGLISH.path, shop("cart-rounding"), shop("release-freeze")],
    chats: [CSS_CHAT],
    expect: {},
  },
];
