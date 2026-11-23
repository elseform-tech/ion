/** Errors whose message is safe and useful to show the user. */
export class UserError extends Error {}

/** ion's question before it goes on (sign out of an agent): the same call again with `confirm: true` goes ahead. */
export class AskFirst extends UserError {}
