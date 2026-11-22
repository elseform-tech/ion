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
];
export const servicePorts = SERVICES.map(([name, port]) => ({
  path: shop(name.toLowerCase().replace(/ /g, "-")),
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
  text: "Staging runs on stg.shop.internal, port 8443.",
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

/** Made-up files for the scale cases: plain facts about many settings, none about the case's question. */
export function fillerSeeds(n: number): Seed[] {
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
