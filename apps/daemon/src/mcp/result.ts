import { UserError } from "../api/errors.js";

export type Result = { content: { type: "text"; text: string }[]; isError?: boolean };

export const ok = (text: string): Result => ({ content: [{ type: "text", text }] });
const refuse = (text: string): Result => ({ content: [{ type: "text", text }], isError: true });
/** Text an agent wrote, quoted so it reads as one string. */
export const q = (s: string) => JSON.stringify(s);

/** Runs a tool body; a refusal (UserError) becomes an error result the agent can read. */
export const guard =
  <A>(f: (a: A) => Result | Promise<Result>) =>
  async (a: A): Promise<Result> => {
    try {
      return await f(a);
    } catch (e) {
      if (e instanceof UserError) return refuse(e.message);
      throw e;
    }
  };
