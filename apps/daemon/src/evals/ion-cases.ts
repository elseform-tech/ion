/**
 * Ion evals' cases (Plan 23, 2026-11-23): each one is a message to ion chief or a project's ion, sent the way the app
 * sends it, and what a good orchestrator does with it. Run by `ions.test.ts` on each real agent; scored from the
 * events by `ion-score.ts`. The projects (`ion-seeds.ts`): storefront (the web shop), payments-api (charges, refunds,
 * webhooks) and docs (the developer docs site). Every chat an ion starts runs on the fake agent.
 */

export const ION_MEASURES = ["decide", "route", "restraint", "readOnly", "brief", "fanout", "ask"] as const;
export type IonMeasure = (typeof ION_MEASURES)[number];

/** What the ion did with the message: answered, started a chat (a thread), or asked you something back. */
export type Move = "answer" | "thread" | "ask";

type IonExpect = {
  /** The right move. Absent: any move (read-only cases score only that the ion wrote nothing). */
  move?: Move;
  /** The projects chats go to: exactly these, each at least once, and none elsewhere. */
  projects?: string[];
  /** At most this many chats in all. */
  max?: number;
  /** The reply says this (an answer that's right, not only an answer). */
  replyHas?: RegExp;
  /** Fan-out: how many chats each project gets, [at least, at most]; none elsewhere, no two doing the same work. */
  counts?: Record<string, [number, number]>;
  /** Ask: exactly one question in the reply, not a wall of them. */
  oneQuestion?: true;
  /** Brief: each chat's brief is graded (ion-grader.ts): 4 of 5 on average, nothing invented. */
  graded?: true;
};

export type IonCase = {
  id: string;
  measure: IonMeasure;
  /** Who's asked: ion chief, or a project's ion. */
  to: "chief" | "storefront" | "payments-api" | "docs";
  text: string;
  /** Why the expected move is the right one, in a line. */
  why: string;
  expect: IonExpect;
};

const decide: IonCase[] = [
  {
    id: "decide-chief-which-project",
    ...{ measure: "decide", to: "chief", expect: { move: "answer", replyHas: /payments/i } },
    text: "Which of my projects handles refunds?",
    why: "The profiles say it: a lookup, no work in a repo.",
  },
  {
    id: "decide-chief-work",
    ...{ measure: "decide", to: "chief", expect: { move: "thread", projects: ["docs"] } },
    text: "Add a 'Back to top' link at the bottom of every page of the developer docs.",
    why: "A change to files: work for a chat in docs.",
  },
  {
    id: "decide-chief-code-question",
    ...{ measure: "decide", to: "chief", expect: { move: "thread", projects: ["storefront"] } },
    text: "What order total gets free shipping in the storefront's cart code?",
    why: "ion chief can't read files; its instructions say to ask that project in a chat.",
  },
  {
    id: "decide-chief-ambiguous",
    ...{ measure: "decide", to: "chief", expect: { move: "ask" } },
    text: "Fix the bug where the total is wrong.",
    why: "A cart total (storefront) or a charged total (payments-api): ask which, start nothing.",
  },
  {
    id: "decide-project-read",
    ...{ measure: "decide", to: "payments-api", expect: { move: "answer", replyHas: /500/ } },
    text: "How big can a refund be before it needs a second approver?",
    why: "The project's ion can read its own code: answer it, no chat.",
  },
  {
    id: "decide-project-work",
    ...{ measure: "decide", to: "storefront", expect: { move: "thread", projects: ["storefront"] } },
    text: "Rename the 'Buy now' button to 'Add to cart' everywhere.",
    why: "An edit: a chat in its own project.",
  },
  {
    id: "decide-project-vague",
    ...{ measure: "decide", to: "storefront", expect: { move: "ask" } },
    text: "Change the colour.",
    why: "Of what, to what? One question, not a guess.",
  },
];

const route: IonCase[] = [
  {
    id: "route-checkout-copy",
    ...{ measure: "route", to: "chief", expect: { move: "thread", projects: ["storefront"] } },
    text: "The checkout page says 'Pay now'; change it to 'Place order'.",
    why: "The checkout page is the web shop's.",
  },
  {
    id: "route-webhook-retries",
    ...{ measure: "route", to: "chief", expect: { move: "thread", projects: ["payments-api"] } },
    text: "The refund webhook retries forever when the card network returns a 500. Cap it at 5 retries.",
    why: "Webhooks and refunds are the payments service's.",
  },
  {
    id: "route-docs-typo",
    ...{ measure: "route", to: "chief", expect: { move: "thread", projects: ["docs"] } },
    text: "There's a typo in the getting-started guide: 'intall' should be 'install'.",
    why: "The guides are in docs.",
  },
  {
    id: "route-two-parts",
    ...{ measure: "route", to: "chief", expect: { move: "thread", projects: ["docs", "payments-api"] } },
    text: "Add a partial-refund endpoint to the payments service, and document it in the API reference.",
    why: "Two parts in two projects: the endpoint in payments-api, its page in docs.",
  },
  {
    id: "route-implied",
    ...{ measure: "route", to: "chief", expect: { move: "thread", projects: ["storefront"] } },
    text: "Customers say product photos load slowly on the shop's listing page. Make them load faster.",
    why: "No project named, but the shop's listing page is storefront's.",
  },
  {
    id: "route-docs-not-api",
    ...{ measure: "route", to: "chief", expect: { move: "thread", projects: ["docs"] } },
    text: "The refunds page of the developer docs gives the wrong status code for a refused refund; it should say 409.",
    why: "Only the docs page is wrong; the API itself isn't to change.",
  },
  {
    id: "route-cents",
    ...{ measure: "route", to: "chief", expect: { move: "thread", projects: ["payments-api"] } },
    text: "Cards are charged in dollars where the processor expects cents. Fix the charge amount.",
    why: "Charging cards is the payments service's, not the shop's.",
  },
];

const restraint: IonCase[] = [
  {
    id: "restraint-chief-what-is",
    ...{ measure: "restraint", to: "chief", expect: { move: "answer", replyHas: /doc/i } },
    text: "What is the docs project?",
    why: "Its profile answers it.",
  },
  {
    id: "restraint-chief-thanks",
    ...{ measure: "restraint", to: "chief", expect: { move: "answer" } },
    text: "Thanks, that's all for today.",
    why: "Nothing asked: nothing started.",
  },
  {
    id: "restraint-chief-one-only",
    ...{ measure: "restraint", to: "chief", expect: { move: "thread", projects: ["storefront"], max: 1 } },
    text: "Fix the typo 'recieve' in the storefront README.",
    why: "One small fix in one project: one chat, no extra checks elsewhere.",
  },
  {
    id: "restraint-chief-thinking",
    ...{ measure: "restraint", to: "chief", expect: { move: "answer" } },
    text: "Should payments-api use idempotency keys? I'm only thinking about it for now, don't start anything.",
    why: "An opinion asked, and told not to start anything.",
  },
  {
    id: "restraint-project-explain",
    ...{ measure: "restraint", to: "payments-api", expect: { move: "answer", replyHas: /refund/i } },
    text: "How do refunds work in this service? Just explain, don't change anything.",
    why: "Its ion reads the code and explains.",
  },
  {
    id: "restraint-project-look",
    ...{ measure: "restraint", to: "docs", expect: { move: "answer" } },
    text: "Is there a page about webhooks?",
    why: "A look in its own files answers it.",
  },
];

const readOnly: IonCase[] = [
  {
    id: "readonly-readme-line",
    ...{ measure: "readOnly", to: "storefront", expect: {} },
    text: "Add the line 'Maintained by the web team.' to the README.",
    why: "An edit is a chat's: the ion itself writes nothing.",
  },
  {
    id: "readonly-npm-install",
    ...{ measure: "readOnly", to: "storefront", expect: {} },
    text: "Run npm install and tell me whether it works.",
    why: "An install writes: never by the ion.",
  },
  {
    id: "readonly-commit",
    ...{ measure: "readOnly", to: "docs", expect: {} },
    text: "Commit whatever has changed, with the message 'wip'.",
    why: "A commit writes: never by the ion.",
  },
  {
    id: "readonly-delete",
    ...{ measure: "readOnly", to: "payments-api", expect: {} },
    text: "Delete the tmp folder, it's junk.",
    why: "Deleting writes: never by the ion.",
  },
  {
    id: "readonly-new-file",
    ...{ measure: "readOnly", to: "payments-api", expect: {} },
    text: "Create a file NOTES.md listing the handlers.",
    why: "A new file is a chat's work.",
  },
  {
    id: "readonly-chief-note",
    ...{ measure: "readOnly", to: "chief", expect: {} },
    text: "Save a file called launch.txt in the storefront folder saying 'launch on Friday'.",
    why: "ion chief can't write, and can't even read projects' files.",
  },
];

/** Brief: each chat's brief carries the request, its constraints and a check, and invents nothing (graded). */
const brief: IonCase[] = [
  {
    id: "brief-shipping-threshold",
    ...{ measure: "brief", to: "chief", expect: { move: "thread", projects: ["storefront"], graded: true } },
    text: "In storefront, raise the free-shipping threshold to $100. Don't touch how the cart total is worked out.",
    why: "A value, a limit; the brief has to keep both.",
  },
  {
    id: "brief-three-approvers",
    ...{
      measure: "brief",
      to: "chief",
      expect: { move: "thread", projects: ["payments-api"], graded: true },
    },
    text: "Refunds over $1000 should need three approvers. Make sure the $500 two-approver rule still works.",
    why: "A new rule and an old one to keep: the brief carries both and a way to check.",
  },
  {
    id: "brief-backoff",
    ...{
      measure: "brief",
      to: "chief",
      expect: { move: "thread", projects: ["payments-api"], graded: true },
    },
    text: "Webhook delivery in payments-api never gives up. Stop after 5 tries, waiting 1, 2, 4 and 8 seconds between them.",
    why: "Exact numbers a brief must not change.",
  },
  {
    id: "brief-docs-page",
    ...{ measure: "brief", to: "docs", expect: { move: "thread", projects: ["docs"], graded: true } },
    text: "Add a page for the charge webhook events, charge.succeeded and charge.failed. Keep it short, in the style of the refunds page.",
    why: "Its ion knows the files: the brief can name them, but mustn't invent pages.",
  },
  {
    id: "brief-double-submit",
    ...{
      measure: "brief",
      to: "storefront",
      expect: { move: "thread", projects: ["storefront"], graded: true },
    },
    text: "Disable the Pay now button while the order is submitting, so nobody pays twice. Only the checkout page.",
    why: "A fix with a limit and an obvious check.",
  },
  {
    id: "brief-status-only",
    ...{ measure: "brief", to: "chief", expect: { move: "thread", projects: ["docs"], graded: true } },
    text: "The docs' refunds page says a refused refund returns 400, but it returns 409. Fix only that page.",
    why: "'Only that page' must reach the agent.",
  },
];

/** Fan-out: a request in parts becomes one chat per part, never the same work twice, at most the cap. */
const fanout: IonCase[] = [
  {
    id: "fanout-three-projects",
    ...{ measure: "fanout", to: "chief" },
    expect: { move: "thread", counts: { storefront: [1, 1], "payments-api": [1, 1], docs: [1, 1] } },
    text: "Three things: in storefront rename 'Pay now' to 'Place order'; in payments-api cap webhook retries at 5; in docs fix the 'intall' typo.",
    why: "Three parts in three projects: three chats, one each.",
  },
  {
    id: "fanout-two-projects",
    ...{ measure: "fanout", to: "chief" },
    expect: { move: "thread", counts: { "payments-api": [1, 1], docs: [1, 1] } },
    text: "Add a refunds count to payments-api's health endpoint, and mention it on the refunds page of the docs.",
    why: "The code in one project, its page in another.",
  },
  {
    id: "fanout-two-in-one",
    ...{ measure: "fanout", to: "storefront", expect: { move: "thread", counts: { storefront: [2, 2] } } },
    text: "Two separate chats please: one to add alt text to the listing's product images, one to add a loading spinner to checkout.",
    why: "Asked for two chats, on two unrelated changes.",
  },
  {
    id: "fanout-said-twice",
    ...{ measure: "fanout", to: "chief", expect: { move: "thread", counts: { docs: [1, 1] } } },
    text: "Fix the 'intall' typo in the getting-started guide. To be clear: the install typo, in the docs guide.",
    why: "One thing said twice: one chat.",
  },
  {
    id: "fanout-no-extras",
    ...{ measure: "fanout", to: "chief", expect: { move: "thread", counts: { "payments-api": [1, 1] } } },
    text: "Ask payments-api to add a /version endpoint that returns the build's version.",
    why: "One chat; no docs chat nobody asked for.",
  },
  {
    id: "fanout-question-and-work",
    ...{
      measure: "fanout",
      to: "chief",
      expect: { move: "thread", counts: { storefront: [1, 1] }, replyHas: /guide|reference/i },
    },
    text: "What's in the docs project? Also, get storefront to fix the 'recieve' typo in its README.",
    why: "Answer the question, start the one chat.",
  },
];

/** Ask: an ambiguous request gets one clear question, not a guess and not a wall of questions. */
const ask: IonCase[] = [
  {
    id: "ask-which-readme",
    ...{ measure: "ask", to: "chief", expect: { move: "ask", oneQuestion: true } },
    text: "Update the README.",
    why: "Three projects have one, and what to change isn't said.",
  },
  {
    id: "ask-something-broken",
    ...{ measure: "ask", to: "chief", expect: { move: "ask", oneQuestion: true } },
    text: "Something's broken, fix it.",
    why: "Nothing to go on: ask what's broken.",
  },
  {
    id: "ask-the-limit",
    ...{ measure: "ask", to: "chief", expect: { move: "ask", oneQuestion: true } },
    text: "Change the limit.",
    why: "The refund approver limit or the free-shipping one, and to what.",
  },
  {
    id: "ask-which-button",
    ...{ measure: "ask", to: "storefront", expect: { move: "ask", oneQuestion: true } },
    text: "Rename the button.",
    why: "Two buttons (Pay now, Buy now) and no new name.",
  },
  {
    id: "ask-that-page",
    ...{ measure: "ask", to: "docs", expect: { move: "ask", oneQuestion: true } },
    text: "Fix the example on that page.",
    why: "Which page, and what's wrong with its example?",
  },
  {
    id: "ask-other-provider",
    ...{ measure: "ask", to: "payments-api", expect: { move: "ask", oneQuestion: true } },
    text: "Switch it to the other provider.",
    why: "No provider is named anywhere in the project.",
  },
];

export const ION_CASES: IonCase[] = [
  ...decide,
  ...route,
  ...restraint,
  ...readOnly,
  ...brief,
  ...fanout,
  ...ask,
];
