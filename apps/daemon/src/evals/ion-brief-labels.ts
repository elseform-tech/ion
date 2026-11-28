import type { BriefLabel } from "./ion-grader.js";

/**
 * Hand-labelled briefs for the grader's agreement check (Plan 23 Task 2, 2026-11-28): good and bad, long and short,
 * some inventing facts, on the eval's projects (ion-seeds.ts). The score is the rubric's (ion-grader.ts): request 0–2,
 * constraints 0–1, check 0–1, and 1 for inventing nothing. Long bad ones are here on purpose (Review Focus 3): a
 * grader that rewards length misses them. A check counts only when the brief says it (a test, a condition, the answer
 * to report), never when it's merely implied.
 */

const CHECKOUT = "Change 'Pay now' to 'Place order' on the checkout page.";
const APPROVERS = "Refunds over $1000 should need three approvers. Keep the $500 two-approver rule working.";
const RETRIES = "Make webhook delivery stop after 5 tries. Leave the other webhook code alone.";
const STATUS =
  "The docs' refunds page says a refused refund returns 400; it returns 409. Fix only that page.";
const SHIPPING = "What order total gets free shipping in the storefront's cart code?";
const CENTS = "Cards are charged in dollars where the processor expects cents. Fix the charge amount.";
const DOUBLE =
  "Disable the Pay now button while the order is submitting, so nobody pays twice. Only the checkout page.";

const long = (...parts: string[]) => parts.join(" ");

export const BRIEF_LABELS: BriefLabel[] = [
  {
    ...{ id: "checkout-good-short", projectId: "storefront", request: CHECKOUT, score: 5, invented: false },
    brief:
      "In src/checkout.tsx, change the checkout submit button's text from 'Pay now' to 'Place order'. Change nothing else. Done when the checkout page's button reads 'Place order'.",
    why: "All of it, the limit, a check, nothing made up.",
  },
  {
    ...{ id: "checkout-bad-short", projectId: "storefront", request: CHECKOUT, score: 1, invented: false },
    brief: "Update the checkout.",
    why: "Only gestures at the request; no limit, no check.",
  },
  {
    ...{ id: "checkout-bad-long", projectId: "storefront", request: CHECKOUT, score: 1, invented: true },
    brief: long(
      "The checkout experience needs a refresh. The pay button lives in components/PayButton.jsx and is wired to Stripe Elements through usePayment().",
      "Rework the checkout flow so it feels more modern: move the button below the order summary, add a progress indicator across the three checkout steps, and make sure the copy is friendly and consistent with the rest of the shop.",
      "While you are there, tidy up the styles, migrate the component to the new design tokens, and update any snapshots that change as a result. Use your judgement on the wording of the button.",
    ),
    why: "Drifts into a redesign, drops the exact words, invents a file, a hook and Stripe Elements.",
  },
  {
    ...{
      id: "approvers-good-long",
      projectId: "payments-api",
      request: APPROVERS,
      score: 5,
      invented: false,
    },
    brief: long(
      "In handlers/refund.go, refunds above secondApproverOverUSD (500) need two approvers today.",
      "Add a second threshold: refunds above $1000 need three approvers. Keep the existing rule exactly as it is, so a refund from $501 to $1000 still needs two.",
      "Return ErrNeedsApprover when there are too few approvers, as the current check does.",
      "Add tests: $400 with one approver is sent; $600 with one approver is refused and with two is sent; $1200 with two approvers is refused and with three is sent. Done when those tests pass.",
    ),
    why: "Whole request, keeps the old rule, a precise check, every fact from the file.",
  },
  {
    ...{
      id: "approvers-wrong-number",
      projectId: "payments-api",
      request: APPROVERS,
      score: 3,
      invented: false,
    },
    brief: "Refunds over $2000 should need three approvers instead of two. Keep the $500 rule.",
    why: "The threshold is changed ($2000): request 1, the old rule kept, no check; a changed request, not a project fact.",
  },
  {
    ...{ id: "retries-good-long", projectId: "payments-api", request: RETRIES, score: 5, invented: false },
    brief: long(
      "webhooks/retry.go's Deliver loops until post(e) succeeds, so a webhook that never gets through is retried forever.",
      "Change Deliver so it makes at most 5 attempts in all and then stops, keeping the wait() between attempts.",
      "Don't change anything else under webhooks/ or elsewhere.",
      "Add a test where post always fails and check it is called exactly 5 times; done when that test passes and the existing behaviour for a webhook that succeeds is unchanged.",
    ),
    why: "All of it, the limit, a check; facts match the file.",
  },
  {
    ...{ id: "retries-no-limit", projectId: "payments-api", request: RETRIES, score: 4, invented: false },
    brief: "Make Deliver in webhooks/retry.go stop after 5 tries. Add a test that a 6th try never happens.",
    why: "Drops 'leave the other webhook code alone'; otherwise right, with a check.",
  },
  {
    ...{ id: "status-good-short", projectId: "docs", request: STATUS, score: 5, invented: false },
    brief:
      "In api/refunds.md, change the status for a refused refund from 400 to 409. Edit only that page. Done when api/refunds.md says a refused refund returns 409.",
    why: "Exact, the limit kept, a check.",
  },
  {
    ...{ id: "status-extra-work", projectId: "docs", request: STATUS, score: 3, invented: false },
    brief:
      "Fix the refused-refund status code to 409 in api/refunds.md, and also update api/charges.md and the payments service so every refusal returns 409. Done when all three agree.",
    why: "Adds work the user ruled out ('only that page'): constraints 0, and the request is no longer just that page.",
  },
  {
    ...{ id: "shipping-good-short", projectId: "storefront", request: SHIPPING, score: 5, invented: false },
    brief:
      "Read src/cart.ts and reply with the order total that ships free (the value of FREE_SHIPPING_OVER), quoting the line. Change nothing.",
    why: "Asks for exactly the answer, says what to report, no change.",
  },
  {
    ...{ id: "shipping-misread", projectId: "storefront", request: SHIPPING, score: 1, invented: false },
    brief: "Change the free shipping threshold in the cart.",
    why: "A question turned into a change: request 0, a new task.",
  },
  {
    ...{
      id: "shipping-invented-value",
      projectId: "storefront",
      request: SHIPPING,
      score: 4,
      invented: true,
    },
    brief:
      "The free-shipping threshold is $50, set in src/config/shipping.ts. Confirm it and reply with the value. Change nothing.",
    why: "States a wrong value ($50) and a file that isn't there.",
  },
  {
    ...{ id: "cents-good-short", projectId: "payments-api", request: CENTS, score: 5, invented: false },
    brief:
      "In handlers/charge.go, Charge sends amountUSD as dollars; the processor expects cents. Send the amount in whole cents (amountUSD × 100, rounded). Done when a test shows Charge(12.34) sends 1234.",
    why: "Whole request, a check, facts from the file.",
  },
  {
    ...{ id: "cents-verbatim", projectId: "payments-api", request: CENTS, score: 4, invented: false },
    brief: CENTS,
    why: "The request word for word: no constraint to carry, but no check.",
  },
  {
    ...{ id: "cents-invented-tooling", projectId: "payments-api", request: CENTS, score: 4, invented: true },
    brief:
      "Fix handlers/charge.go so the processor gets cents, not dollars. Run `make test` and the Jest suite before you finish; done when both pass.",
    why: "There's no Makefile and no Jest in a Go service: invented tooling.",
  },
  {
    ...{ id: "double-good-long", projectId: "storefront", request: DOUBLE, score: 5, invented: false },
    brief: long(
      "On the checkout page (src/checkout.tsx), the Pay now submit button can be pressed again while the order is still being submitted, which can charge the customer twice.",
      "Disable that button from the moment the order is submitted until the submission finishes, whether it succeeds or fails, then enable it again.",
      "Change only the checkout page; leave BuyNow and the rest of the shop as they are.",
      "Done when pressing the button twice quickly sends one order, and the button is enabled again after a failed submission.",
    ),
    why: "Whole request with its limit, a check, nothing made up.",
  },
  {
    ...{ id: "double-bad-long", projectId: "storefront", request: DOUBLE, score: 2, invented: false },
    brief: long(
      "We want the whole shop to feel more reliable.",
      "Look across the listing, cart and checkout for anything that could make people lose trust: slow screens, confusing labels, buttons that don't respond, layout that jumps around.",
      "Refactor the state handling so it's easier to reason about, add some loading states where they make sense, and consider adding analytics so we can see where people drop off. Prioritise what you think matters most.",
    ),
    why: "The one fix is buried in a shop-wide wish list: request 1, the page limit lost, no check.",
  },
  {
    ...{ id: "double-invented-person", projectId: "storefront", request: DOUBLE, score: 4, invented: true },
    brief:
      "Disable the Pay now button in src/checkout.tsx while the order submits, only on the checkout page. Ask Mei, who owns checkout, to review. Done when a double press sends one order.",
    why: "Right otherwise, but Mei is nowhere in the project: an invented person.",
  },
  {
    ...{
      id: "typo-wrong-project",
      projectId: "docs",
      request: "Fix the 'intall' typo in the getting-started guide.",
      score: 0,
      invented: true,
    },
    brief: "In the storefront README, fix the typo 'recieve'.",
    why: "Another typo in another project: request 0, and it names a file (a storefront README) the docs project hasn't got.",
  },
  {
    ...{
      id: "typo-no-check",
      projectId: "docs",
      request: "Fix the 'intall' typo in the getting-started guide.",
      score: 4,
      invented: false,
    },
    brief: "In guides/getting-started.md, change 'intall' to 'install'. Touch nothing else.",
    why: "Exact and limited, but says no check.",
  },
];

/**
 * The held-out labels (Plan 23 Task 4, 2026-11-28): written after the rubric was settled and never used to tune it or
 * the labels above. The grader's scores count only when it agrees with these too (AGREEMENT_MIN).
 */
export const BRIEF_HELD_OUT: BriefLabel[] = [
  {
    ...{ id: "alt-good-short", projectId: "storefront", score: 5, invented: false },
    request: "Add alt text to the listing's product images.",
    brief:
      "In src/listing.tsx, give each product <img> an alt attribute, using the product's id for now. Change nothing else. Done when every image Listing renders has alt text.",
    why: "All of it, a limit, a check; id and Listing are in the file.",
  },
  {
    ...{ id: "alt-bad-short", projectId: "storefront", score: 1, invented: false },
    request: "Add alt text to the listing's product images.",
    brief: "Improve accessibility.",
    why: "Only gestures at it.",
  },
  {
    ...{ id: "version-invented-paths", projectId: "payments-api", score: 4, invented: true },
    request: "Add a /version endpoint that returns the build's version.",
    brief:
      "Add GET /version to the router in cmd/server/main.go, returning internal/build.Version. Done when a request to /version returns it.",
    why: "Neither cmd/server/main.go nor internal/build exists.",
  },
  {
    ...{ id: "webhooks-page-good", projectId: "docs", score: 5, invented: false },
    request:
      "Document the charge webhook events charge.succeeded and charge.failed, in the refunds page's style.",
    brief:
      "Create api/webhooks.md with a heading and one or two sentences naming `charge.succeeded` and `charge.failed`, in the style of api/refunds.md. Edit no other page. Done when the page exists and names both events.",
    why: "Exact, limited, a check, nothing claimed about what the events mean.",
  },
  {
    ...{ id: "webhooks-page-bad-long", projectId: "docs", score: 1, invented: true },
    request:
      "Document the charge webhook events charge.succeeded and charge.failed, in the refunds page's style.",
    brief: long(
      "Write complete webhook documentation for the platform.",
      "Cover the payload schema for every event, how signatures are verified with HMAC-SHA256 as the payments service does today, and the retry policy (every 30 seconds for up to a day).",
      "Add a troubleshooting section, code samples in three languages, and a changelog.",
      "Reorganise the API reference so webhooks get their own section in the sidebar, and update the getting-started guide to link to it.",
    ),
    why: "Drifts far past one short page; HMAC signing and a 30-second retry are nowhere in the project.",
  },
  {
    ...{ id: "spinner-good-long", projectId: "storefront", score: 5, invented: false },
    request: "Show a loading spinner on checkout while the order submits.",
    brief: long(
      "On the checkout page (the Checkout component in src/checkout.tsx), show a loading spinner while the order is being submitted after Pay now is pressed.",
      "Show it from the moment the submit starts until it finishes, whether it succeeds or fails, and hide it afterwards.",
      "Only the checkout page: leave BuyNow, the listing and the cart as they are.",
      "Done when pressing Pay now shows the spinner during the submit and it's gone once the submit has finished either way.",
    ),
    why: "Whole request, a limit, a check, facts from the file.",
  },
  {
    ...{ id: "retries-no-check", projectId: "payments-api", score: 4, invented: false },
    request: "Cap webhook retries at 5.",
    brief: "Make Deliver in webhooks/retry.go stop after 5 failed posts.",
    why: "Right and limited, no check.",
  },
  {
    ...{ id: "typo-overreach", projectId: "docs", score: 2, invented: false },
    request: "Fix the 'intall' typo.",
    brief: "Fix all typos across the docs and rewrite the getting-started guide to be friendlier.",
    why: "One typo became a rewrite: request 1, extra work.",
  },
  {
    ...{ id: "buynow-question-good", projectId: "storefront", score: 5, invented: false },
    request: "What does BuyNow render?",
    brief:
      "Read src/checkout.tsx and reply with what the BuyNow component renders, quoting its JSX. Change nothing.",
    why: "Asks for exactly the answer to report.",
  },
  {
    ...{ id: "cents-bad-long", projectId: "payments-api", score: 1, invented: true },
    request: "Charge amounts must be sent in cents.",
    brief: long(
      "Finance (Priya) has reported currency bugs for months, and the team wants money handled properly everywhere.",
      "Introduce a Money type across the payments service and the storefront, migrate every amount to it, add currency codes, and update the database schema and the refunds flow to match.",
      "Take the time to clean up anything else in the money paths you find along the way.",
    ),
    why: "A one-line fix buried in a migration; Priya, a database and currency codes are nowhere in the project.",
  },
  {
    ...{ id: "shipping-good-check", projectId: "storefront", score: 5, invented: false },
    request: "Raise free shipping to $100.",
    brief:
      "In src/cart.ts, set FREE_SHIPPING_OVER to 100 (it is 75 now). Change nothing else. Done when FREE_SHIPPING_OVER is 100.",
    why: "Exact, with the file's value, a limit and a check.",
  },
  {
    ...{ id: "shipping-wrong-value", projectId: "storefront", score: 3, invented: false },
    request: "Raise free shipping to $100.",
    brief: "Set free shipping to $150.",
    why: "The value changed: request 1; nothing claimed about the project; no check.",
  },
];
