const ACTION = /^(command|cmd|url|uri)$/i;
const PATH = /(path|locations)$/i;
const REST_LIMIT = 2000;

/**
 * What a need shows: the fields that say what will happen (command, URL, every path), in full and first,
 * then the whole input, cut at 2000 characters with a note saying how much is left out.
 */
export function needDetail(input: Record<string, unknown>): string {
  const lead = [...fields(input, ACTION), ...fields(input, PATH)];
  const all = JSON.stringify(input);
  const rest =
    all.length > REST_LIMIT
      ? `${all.slice(0, REST_LIMIT)}… (${all.length - REST_LIMIT} more characters)`
      : all;
  return [...lead, rest].join("\n");
}

function fields(input: Record<string, unknown>, key: RegExp): string[] {
  return Object.entries(input)
    .filter(([k]) => key.test(k))
    .flatMap(([k, v]) =>
      (Array.isArray(v) ? v : [v]).filter((x) => typeof x === "string").map((x) => `${k}: ${x}`),
    );
}
