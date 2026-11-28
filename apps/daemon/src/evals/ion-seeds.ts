import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { EV } from "@ion/schema";
import { EventStore, openDb } from "../store/index.js";
import { allViews } from "../views/index.js";

/**
 * The ion evals' made-up projects (Plan 23, 2026-11-23): three repos an orchestrator has to tell apart, each with a
 * README, a profile and a few files holding the facts the cases ask about.
 */

export type SeedProject = { id: string; profile: string; files: Record<string, string> };

const storefront: SeedProject = {
  id: "storefront",
  profile: "The web shop customers use: product listing, cart and checkout pages (React).",
  files: {
    "README.md":
      "# Storefront\n\nThe customer-facing web shop: the product listing, the cart and the checkout pages.\n\nWe recieve orders on the checkout page and send them to the payments service.\n",
    "package.json":
      '{\n  "name": "storefront",\n  "scripts": { "dev": "vite" },\n  "dependencies": { "react": "^18.3.1" }\n}\n',
    "src/cart.ts":
      "/** Orders over this total (USD) ship free. */\nexport const FREE_SHIPPING_OVER = 75;\n\nexport function total(items: { price: number; qty: number }[]): number {\n  return items.reduce((n, i) => n + i.price * i.qty, 0);\n}\n",
    "src/checkout.tsx":
      'export function Checkout() {\n  return <button type="submit">Pay now</button>;\n}\n\nexport function BuyNow() {\n  return <button>Buy now</button>;\n}\n',
    "src/listing.tsx":
      "export function Listing({ products }: { products: { id: string; photo: string }[] }) {\n  return products.map((p) => <img key={p.id} src={p.photo} />);\n}\n",
  },
};

const paymentsApi: SeedProject = {
  id: "payments-api",
  profile: "Charges cards, issues refunds and sends webhooks for the shop (a Go service).",
  files: {
    "README.md":
      "# Payments API\n\nThe service that charges cards, issues refunds and sends webhooks to the shop. Written in Go.\n",
    "handlers/refund.go":
      "package handlers\n\n// Refunds above this amount (USD) need a second approver before they are sent.\nconst secondApproverOverUSD = 500\n\nfunc Refund(amountUSD int, approvers int) error {\n\tif amountUSD > secondApproverOverUSD && approvers < 2 {\n\t\treturn ErrNeedsApprover\n\t}\n\treturn send(amountUSD)\n}\n",
    "handlers/charge.go":
      "package handlers\n\n// Charge sends the amount to the card processor.\nfunc Charge(amountUSD float64) error {\n\treturn processor.Charge(amountUSD)\n}\n",
    "webhooks/retry.go":
      "package webhooks\n\n// Deliver retries until the shop answers.\nfunc Deliver(e Event) {\n\tfor !post(e) {\n\t\twait()\n\t}\n}\n",
    "tmp/old.log": "2026-10-01 started\n",
  },
};

const docs: SeedProject = {
  id: "docs",
  profile: "The public developer docs site: guides and the API reference (Markdown).",
  files: {
    "README.md":
      "# Docs\n\nThe public developer documentation site, in Markdown: the guides and the API reference.\n",
    "guides/getting-started.md":
      "# Getting started\n\nTo intall the client, run `npm install @shop/client`.\n",
    "api/refunds.md": "# Refunds\n\n`POST /refunds` refunds a charge. A refused refund returns `400`.\n",
    "api/charges.md": "# Charges\n\n`POST /charges` charges a card. Amounts are in USD.\n",
  },
};

const ION_PROJECTS: SeedProject[] = [storefront, paymentsApi, docs];

/** A seeded project by its id. */
export const projectOf = (id: string): SeedProject | undefined => ION_PROJECTS.find((p) => p.id === id);

/** The projects, turned `by` places (each case's runs see them in another order: Review Focus 2). */
export const rotated = (by: number): SeedProject[] =>
  ION_PROJECTS.map((_, i) => ION_PROJECTS[(i + by) % ION_PROJECTS.length]!);

/** Writes a project's files under its folder (its git repo is made by the caller). */
export function writeProject(dir: string, p: SeedProject): void {
  for (const [name, text] of Object.entries(p.files)) {
    mkdirSync(join(dir, name, ".."), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
}

const q = (s: string) => JSON.stringify(s);

/**
 * The case's config: the agent under test thinks for every ion and judges; the projects, in this order, with their
 * profiles, put their chats on the fake agent; no briefing (it would be a turn of its own).
 */
export function ionConfig(o: {
  agent: string;
  root: string;
  projects: SeedProject[];
  threadsOn: string;
  /** What ion does when a chat's agent hits its limit (absent: ion's default, ask). */
  onLimit?: "ask" | "wait";
}): string {
  const projects = o.projects.map((p) =>
    [
      "[[projects]]",
      `id = ${q(p.id)}`,
      `path = ${q(join(o.root, p.id))}`,
      `harness = ${q(o.threadsOn)}`,
      `profile = ${q(p.profile)}`,
    ].join("\n"),
  );
  const limitLine = o.onLimit ? "\nonLimit = " + q(o.onLimit) : "";
  return [
    `[ion]\nquick = ${q(o.agent)}\ndeep = ${q(o.agent)}`,
    `[access]\njudge = ${q(o.agent)}`,
    `[routing]\norder = [${q(o.agent)}]${limitLine}`,
    "[notifications.briefing]\non = false",
    `[folders]\nprojects = ${q(o.root)}`,
    ...projects,
  ].join("\n\n");
}

/**
 * Marks the fake agent limited for the next hour, before the daemon starts: a project's ion then thinks on the agent
 * under test (it goes past a limited agent of its project's), while its chats still go on the fake agent, which runs
 * don't check. The first of its chats to end well clears the mark (views/usage.ts). `sticky` (Task 3: chats seeded
 * before the message, a thread's report after it): the mark is dated two hours ahead, so no chat that ends well clears
 * it and every ion turn of the case stays on the agent under test.
 */
export function fakeLimited(dataDir: string, sticky = false): void {
  const ahead = sticky ? 2 * 3_600_000 : 0;
  mkdirSync(dataDir, { recursive: true });
  const db = openDb(join(dataDir, "ion.db"));
  try {
    new EventStore(db, allViews).append({
      ...(sticky ? { ts: new Date(Date.now() + ahead).toISOString() } : {}),
      chatId: null,
      runId: null,
      origin: "adapter",
      type: EV.error,
      data: {
        code: "limit",
        retryable: false,
        message: "ion evals: an ion's turn goes on the agent under test",
        limit: { resetsAt: new Date(Date.now() + ahead + 3_600_000).toISOString() },
        harness: "fake",
      },
    });
  } finally {
    db.close();
  }
}
