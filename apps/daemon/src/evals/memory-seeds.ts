import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { MemoryScope } from "@ion/schema";
import { openMemory } from "../memory/index.js";
import { type Caller, ScopedMemory } from "../memory/scoped.js";
import { EventStore, openDb } from "../store/index.js";
import { allViews } from "../views/index.js";

/** The memory evals' seeded files (Task 5, 2026-11-22): look-alikes for precision, filler for scale. */

/** A memory file put in the folder before the daemon starts: its path in the folder, its header and its text. */
export type Seed = {
  path: string;
  header: Record<string, string>;
  text: string;
};

export const shop = (slug: string) => `projects/shop/${slug}.md`;
export const bank = (slug: string) => `projects/bank/${slug}.md`;
export const you = (slug: string) => `you/${slug}.md`;
export const h = (name: string, description: string, type: string, more: Record<string, string> = {}) => ({
  name,
  description,
  type,
  ...more,
});

/** Look-alike files for precision: services and their ports, each a file of its own. */
export const SERVICES: [string, string][] = [
  ["Search service", "9200"],
  ["Cache", "6379"],
  ["Queue", "5672"],
  ["Metrics", "9090"],
  ["Auth service", "7443"],
  ["Orders database", "5433"],
  ["Inventory service", "8085"],
  ["Mail relay", "2525"],
  ["Image proxy", "8099"],
  ["Admin panel", "8800"],
  ["Payments database", "6543"],
  // Near-misses (task review, 2026-11-22): the right word, the wrong file.
  ["Payments database (old)", "6542"],
  ["Payments cache", "6544"],
];
export const servicePorts = SERVICES.map(([name, port]) => ({
  path: shop(
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/-$/, ""),
  ),
  header: h(name, `${name}: where it runs`, "reference"),
  text: `${name} runs on port ${port} in every environment.`,
}));

export const OWNERS: [string, string][] = [
  ["checkout", "Mei"],
  ["search", "Tomasz"],
  ["catalog", "Ines"],
  ["shipping", "Kwame"],
  ["reviews", "Liesel"],
];
export const owners = OWNERS.map(([area, who]) => ({
  path: shop(`${area}-owner`),
  header: h(`Who owns ${area}`, `The ${area} code's owner`, "person"),
  text: `${who} owns the ${area} code and reviews every change to it.`,
}));

export const STAGING: Seed = {
  path: shop("staging-server"),
  header: h("Staging server", "Where staging runs: host and port", "reference"),
  text: "Staging runs on stg.shop.internal, port 8471.",
};

const AREAS = [
  "checkout",
  "search",
  "catalog",
  "shipping",
  "reviews",
  "billing",
  "emails",
  "admin",
  "images",
];
const KINDS = ["timeout", "retry limit", "batch size", "cache time", "page size"];

/**
 * Near-misses for the scale cases (task review, 2026-11-22): secrets that rotate on other schedules, a webhook's
 * other settings, another tax registration. None answers a case's question.
 */
const LOOK_ALIKES: Seed[] = [
  ["Webhook retry limit", "Webhooks are retried 5 times, then dropped."],
  ["Webhook timeout", "A webhook call times out after 10 seconds."],
  ["API key rotation", "The API key rotates every 90 days."],
  ["Session secret", "The session secret rotates every 30 days."],
  ["Signing key for emails", "The email signing key rotates every 180 days."],
  ["VAT number", "The shop's VAT filings go out each quarter."],
  ["Payment provider country", "The payment provider is registered in Ireland."],
].map(([name, text]) => ({
  path: shop(name!.toLowerCase().replace(/ /g, "-")),
  header: h(name!, `${name}: the setting`, "fact"),
  text: text!,
}));

/**
 * Made-up files for the scale cases: plain facts about many settings, with near-misses first, none answering the
 * case's question.
 */
export function fillerSeeds(n: number): Seed[] {
  return [...LOOK_ALIKES, ...plainFiller(n - LOOK_ALIKES.length)];
}

function plainFiller(n: number): Seed[] {
  return Array.from({ length: n }, (_, i) => {
    const area = AREAS[i % AREAS.length]!;
    const kind = KINDS[Math.floor(i / AREAS.length) % KINDS.length]!;
    const name = `${area} ${kind} ${i}`;
    return {
      path: shop(`filler-${i}`),
      header: h(name, `The ${kind} for ${area}, setting ${i}`, "fact"),
      text: `The ${kind} for ${area} (setting ${i}) is ${10 + (i % 90)} units.`,
    };
  });
}

const scopeOf = (path: string): MemoryScope =>
  path.startsWith("you/") ? "you" : { projectId: path.split("/")[1]! };

/**
 * Writes the seeds in order, as you, before ion starts: the first is the oldest, so with enough after it, it's not in
 * the up-front index and must be searched for (task review, 2026-11-22).
 */
export function seedMemory(dataDir: string, seeds: Seed[]): void {
  mkdirSync(dataDir, { recursive: true });
  const db = openDb(join(dataDir, "ion.db"));
  try {
    const memory = openMemory(dataDir, new EventStore(db, allViews), db);
    for (const s of seeds) {
      const header = s.header as unknown as Parameters<typeof memory.write>[0]["header"];
      const slug = s.path.split("/").at(-1)!.slice(0, -3);
      memory.write({ scope: scopeOf(s.path), slug, header, text: s.text, by: "you" });
    }
  } finally {
    db.close();
  }
}

/** The up-front index a chat in shop (or shop's ion) starts with, for checking a scale case needs search. */
export function upFrontOf(dataDir: string, who: "chat" | "ion"): string {
  const db = openDb(join(dataDir, "ion.db"));
  try {
    const memory = openMemory(dataDir, new EventStore(db, allViews), db);
    const caller: Caller =
      who === "chat"
        ? { kind: "chat", chatId: "c", runId: "r", projectId: "shop" }
        : { kind: "ion", ionId: "shop", projects: ["shop"] };
    return new ScopedMemory(memory, caller).indexBlock()?.body ?? "";
  } finally {
    db.close();
  }
}
